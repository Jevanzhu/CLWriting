/**
 * R75-5（批 D）回归：删书/改名的跨进程任务闸查询缺口。
 *
 * heldTaskGatesFor 只读进程内 Set——dev-api/脚本与 GUI 双进程并存时，进程 B 的
 * DELETE/RENAME 感知不到进程 A 持有的分钟级任务闸。修复后 busyGate 合并
 * crossProcessHeldTaskGatesFor（扫任务闸锁文件目录，只读不取锁）：
 *
 * - 单元：活 pid 载荷 → 该 action 算在持；死 pid / 活 pid 超龄无续期（mtime 回拨
 *   > 10min）→ 陈锁不算在持（勿把崩溃残留算成在持导致删书被永久 409）。
 * - 端点：手写他进程在持锁文件 → DELETE 409（文案含 action）；陈锁/删除 → 放行。
 */
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createHash } from 'node:crypto'
import { beforeAll, afterAll, describe, it, expect } from 'vitest'
import { startServerSafe } from '../helpers/safe-port.js'
import { crossProcessHeldTaskGatesFor } from '../../src/studio/server/api/task-gate.js'
import { mkdtempTracked } from '../helpers/temp-dir.js'

// 复现锁文件名算法（sha256(key) 前 16 hex；key = action + NUL + book）——与 task-gate.ts 同源约定
const gateKey = (action: string, book: string): string => `${action}\u0000${book}`
const lockName = (action: string, book: string): string =>
  `${createHash('sha256').update(gateKey(action, book)).digest('hex').slice(0, 16)}.lock`

const roots: string[] = []
function freshDir(): string {
  const d = mkdtempTracked(join(tmpdir(), 'r75-xproc-gate-'))
  roots.push(d)
  return d
}
afterAll(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true })
})

describe('R75-5 crossProcessHeldTaskGatesFor 单元语义', () => {
  it('活 pid 载荷（他进程在持）→ 返回该 action', () => {
    const dir = freshDir()
    mkdirSync(dir, { recursive: true })
    // 模拟进程 A 已 O_EXCL 创建的锁文件：pid 取本进程（探测必活）——等价他进程在持
    writeFileSync(join(dir, lockName('rag-build', '跨进程查询书')), JSON.stringify({ pid: process.pid, bootTime: Date.now() }))
    writeFileSync(join(dir, lockName('analyze', '跨进程查询书')), JSON.stringify({ pid: process.pid, bootTime: Date.now() }))
    // 别的书的同名 action 锁不应混入
    writeFileSync(join(dir, lockName('analyze', '别的书')), JSON.stringify({ pid: process.pid, bootTime: Date.now() }))
    expect(crossProcessHeldTaskGatesFor('跨进程查询书', { lockDir: dir }).sort()).toEqual(['analyze', 'rag-build'])
    expect(crossProcessHeldTaskGatesFor('别的书', { lockDir: dir })).toEqual(['analyze'])
  })

  it('死 pid 载荷（进程 A 已崩溃）→ 陈锁不算在持', () => {
    const dir = freshDir()
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, lockName('analyze', '陈锁书')), JSON.stringify({ pid: 4194303, bootTime: 1 }))
    // isProcessAlive 注入 false（跨平台稳定复现「持有进程已退出」；先例同 task-gate.test.ts）
    expect(crossProcessHeldTaskGatesFor('陈锁书', { lockDir: dir, isProcessAlive: () => false })).toEqual([])
  })

  it('活 pid 但锁龄超 10min 无续期（Z-19 语义）→ 不算在持', () => {
    const dir = freshDir()
    mkdirSync(dir, { recursive: true })
    const p = join(dir, lockName('review', '超龄书'))
    writeFileSync(p, JSON.stringify({ pid: process.pid, bootTime: Date.now() }))
    const past = new Date(Date.now() - 11 * 60_000)
    utimesSync(p, past, past)
    // 真 isProcessAlive（本 pid 必活）——持有者活着但超龄无续期仍判 stale（pid 复用防护）
    expect(crossProcessHeldTaskGatesFor('超龄书', { lockDir: dir })).toEqual([])
  })

  it('锁目录不存在 / 未配置 → 返回空（fail-open，同 lockRoot=null 纯内存口径）', () => {
    expect(crossProcessHeldTaskGatesFor('任意书', { lockDir: join(freshDir(), '不存在子目录') })).toEqual([])
    expect(crossProcessHeldTaskGatesFor('任意书', { lockDir: null })).toEqual([])
  })
})

// ── 端点接线：busyGate 合并跨进程扫描后判 409 ──────────────────────────
const BOOK = 'R75跨进程删书'
let workDir = ''
let server: http.Server | undefined
let baseUrl = ''
let token = ''

function req(method: string, path: string, body?: unknown): Promise<{ status: number; json: unknown }> {
  return new Promise((resolve, reject) => {
    const u = new URL(baseUrl)
    const payload = body ? JSON.stringify(body) : ''
    const r = http.request(
      {
        host: u.hostname,
        port: u.port,
        path,
        method,
        headers: {
          'x-studio-token': token,
          origin: baseUrl,
          ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}),
        },
      },
      (res) => {
        let data = ''
        res.on('data', (c) => (data += c.toString('utf8')))
        res.on('end', () => {
          let json: unknown = null
          try {
            json = JSON.parse(data)
          } catch {
            /* 非 JSON */
          }
          resolve({ status: res.statusCode ?? 0, json })
        })
      },
    )
    r.on('error', reject)
    if (payload) r.write(payload)
    r.end()
  })
}

/** 在共享 workDir 里登记一本可删除的书（每用例独立书名，避免用例间删书互相影响）。 */
function registerBook(name: string): string {
  const booksFile = join(workDir, '.clwriting', 'books.jsonl')
  writeFileSync(booksFile, JSON.stringify({ name, path: name, kind: 'long' }) + '\n', { flag: 'a' })
  const bookRoot = join(workDir, name)
  mkdirSync(join(bookRoot, '大纲'), { recursive: true })
  writeFileSync(join(bookRoot, 'book.yaml'), `spec_version: 1\nkind: long\nbook:\n  title: ${name}\n  genre: 玄幻\nhost: cc\nleads:\n  enabled: []\n`)
  return bookRoot
}

beforeAll(async () => {
  workDir = mkdtempSync(join(tmpdir(), 'clw-r75-xproc-'))
  mkdirSync(join(workDir, '.clwriting'), { recursive: true })
  writeFileSync(join(workDir, '.clwriting', 'books.jsonl'), '')
  server = await startServerSafe({ port: 0, workDir })
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const r = await fetch(`${baseUrl}/api/boot`)
  token = ((await r.json()) as { token: string }).token
})

afterAll(async () => {
  if (server) await new Promise<void>((r) => server!.close(() => r()))
  if (workDir) rmSync(workDir, { recursive: true, force: true })
})

describe('R75-5 busyGate 端点接线（DELETE 跨进程闸 409）', () => {
  it('他进程在持锁文件（活 pid）→ 删书 409 且文案含 action；锁删除后放行', async () => {
    const name = `${BOOK}-活锁`
    registerBook(name)
    // startServer 已把锁根注入 workDir/.clwriting/task-gate/——手写活 pid 锁文件
    // 模拟「另一进程正持 rag-build 闸」（本进程 Set 看不见，旧行为会放行删书）
    const lockPath = join(workDir, '.clwriting', 'task-gate', lockName('rag-build', name))
    mkdirSync(dirname(lockPath), { recursive: true })
    writeFileSync(lockPath, JSON.stringify({ pid: process.pid, bootTime: Date.now() }))

    const busy = await req('DELETE', `/api/books/${encodeURIComponent(name)}`)
    expect(busy.status).toBe(409)
    expect((busy.json as { error: string }).error).toContain('rag-build')

    rmSync(lockPath, { force: true })
    const ok = await req('DELETE', `/api/books/${encodeURIComponent(name)}`)
    expect(ok.status).toBe(200)
  })

  it('陈锁（活 pid 但超龄无续期）→ 不算在持，删书照常放行', async () => {
    const name = `${BOOK}-陈锁`
    registerBook(name)
    const lockPath = join(workDir, '.clwriting', 'task-gate', lockName('analyze', name))
    mkdirSync(dirname(lockPath), { recursive: true })
    writeFileSync(lockPath, JSON.stringify({ pid: process.pid, bootTime: Date.now() }))
    const past = new Date(Date.now() - 11 * 60_000)
    utimesSync(lockPath, past, past) // 持有 pid 活着但锁龄超 Z-19 的 10min 线 → 陈锁

    const ok = await req('DELETE', `/api/books/${encodeURIComponent(name)}`)
    expect(ok.status).toBe(200)
  })
})
