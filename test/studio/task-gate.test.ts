/**
 * RB-SV-P2-2 回归：长任务并发闸。
 *
 * - acquireTaskGate 单元语义：首占成功 / 重复占返回 null / release 幂等 / 释放后可再占 /
 *   book 或 action 不同互不阻塞
 * - 端点接线：闸被持有时 relations/mine 与 outline 回 409；释放后 outline 走通（mock）
 */
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, beforeAll, describe, it, expect } from 'vitest'
import { startServer } from '../../src/studio/server/index.js'
import { acquireTaskGate, isTaskGateHeld, heldTaskGatesFor } from '../../src/studio/server/api/task-gate.js'
import { createHash } from 'node:crypto'

const BOOK = '闸测试书'
let workDir = ''
let userDataPath = ''
let server: http.Server | undefined
let baseUrl = ''
let token = ''
const prevDriver = process.env['CLWRITING_DRIVER']

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
        res.on('data', (c) => (data += c.toString('utf-8')))
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

beforeAll(async () => {
  process.env['CLWRITING_DRIVER'] = 'mock'
  workDir = mkdtempSync(join(tmpdir(), 'clwriting-gate-'))
  userDataPath = mkdtempSync(join(tmpdir(), 'clwriting-gate-ud-'))
  mkdirSync(join(workDir, '.clwriting'), { recursive: true })
  writeFileSync(join(workDir, '.clwriting', 'books.jsonl'), JSON.stringify({ name: BOOK, path: BOOK, kind: 'long' }) + '\n')
  const bookRoot = join(workDir, BOOK)
  mkdirSync(join(bookRoot, '大纲'), { recursive: true })
  mkdirSync(join(bookRoot, '写作', '正文'), { recursive: true })
  writeFileSync(join(bookRoot, 'book.yaml'), 'spec_version: 1\nkind: long\nbook:\n  title: 闸测试书\n  genre: 玄幻\nhost: cc\nleads:\n  enabled: []\n')
  server = startServer({ port: 0, workDir, userDataPath })
  await new Promise<void>((r) => server!.once('listening', r))
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const r = await fetch(`${baseUrl}/api/boot`)
  token = ((await r.json()) as { token: string }).token
})

afterAll(async () => {
  if (server) await new Promise<void>((r) => server!.close(() => r()))
  if (workDir) rmSync(workDir, { recursive: true, force: true })
  if (userDataPath) rmSync(userDataPath, { recursive: true, force: true })
  if (prevDriver === undefined) delete process.env['CLWRITING_DRIVER']
  else process.env['CLWRITING_DRIVER'] = prevDriver
})

describe('acquireTaskGate 单元语义', () => {
  it('首占成功 → 重复占 null → 释放后可再占', () => {
    const release = acquireTaskGate('单元书', 'unit-action')
    expect(release).not.toBeNull()
    expect(isTaskGateHeld('单元书', 'unit-action')).toBe(true)
    expect(acquireTaskGate('单元书', 'unit-action')).toBeNull()
    release!()
    expect(isTaskGateHeld('单元书', 'unit-action')).toBe(false)
    const again = acquireTaskGate('单元书', 'unit-action')
    expect(again).not.toBeNull()
    again!()
  })

  it('release 幂等（多次调用不误删后占的闸）', () => {
    const r1 = acquireTaskGate('幂等书', 'idem-action')
    r1!()
    r1!() // 第二次重复释放应为 no-op
    const r2 = acquireTaskGate('幂等书', 'idem-action')
    expect(r2).not.toBeNull()
    r2!()
  })

  it('book 或 action 不同互不阻塞', () => {
    const ra = acquireTaskGate('书A', 'act')
    const rb = acquireTaskGate('书B', 'act')
    const rc = acquireTaskGate('书A', 'other-act')
    expect(ra && rb && rc).toBeTruthy()
    ra!()
    rb!()
    rc!()
  })
})

describe('heldTaskGatesFor（dd-P2：按书聚合持闸动作）', () => {
  it('返回该书全部持闸动作，不含其他书', () => {
    const ra = acquireTaskGate('聚合书', 'rag-build')
    const rb = acquireTaskGate('聚合书', 'analyze')
    const rc = acquireTaskGate('别的书', 'rag-build') // 同 action 不同书
    expect(heldTaskGatesFor('聚合书').sort()).toEqual(['analyze', 'rag-build'])
    expect(heldTaskGatesFor('别的书')).toEqual(['rag-build'])
    expect(heldTaskGatesFor('无闸书')).toEqual([])
    ra!()
    rb!()
    rc!()
    expect(heldTaskGatesFor('聚合书')).toEqual([])
  })

  it('书名本身含冒号也不误判（键格式 action:book）', () => {
    const r = acquireTaskGate('带:冒号:书', 'rag-build')
    expect(heldTaskGatesFor('带:冒号:书')).toEqual(['rag-build'])
    expect(heldTaskGatesFor('冒号:书')).toEqual([])
    r!()
  })
})

// ── T2-4：跨进程文件锁 ────────────────────────────────
// 复现锁文件名算法（sha256(key) 前 16 hex）——手写 lockfile 模拟「另一进程已持锁」
const gateKey = (action: string, book: string): string => `${action}\u0000${book}`
const lockName = (action: string, book: string): string =>
  `${createHash('sha256').update(gateKey(action, book)).digest('hex').slice(0, 16)}.lock`

describe('T2-4 task-gate 跨进程文件锁', () => {
  let lockDir = ''
  beforeAll(() => {
    lockDir = mkdtempSync(join(tmpdir(), 'clwriting-gate-lock-'))
  })
  afterAll(() => {
    if (lockDir) rmSync(lockDir, { recursive: true, force: true })
  })

  it('锁文件被存活进程持有 → acquire 返回 null（模拟另一进程持锁，本进程 Set 看不见）', () => {
    // 手写 lockfile = 另一进程已 O_EXCL 创建（pid 取本进程——探测必活）
    writeFileSync(join(lockDir, lockName('analyze', '跨进程书')), JSON.stringify({ pid: process.pid, bootTime: Date.now() }))
    const r = acquireTaskGate('跨进程书', 'analyze', { lockDir, isProcessAlive: () => true })
    expect(r).toBeNull()
    expect(isTaskGateHeld('跨进程书', 'analyze')).toBe(false) // 未误登进本进程 Set
  })

  it('锁文件持有进程已死（stale）→ 接管清理后占闸成功，写入自己的 pid', () => {
    writeFileSync(join(lockDir, lockName('rewrite', '跨进程书')), JSON.stringify({ pid: 4194303, bootTime: 1 }))
    const r = acquireTaskGate('跨进程书', 'rewrite', { lockDir, isProcessAlive: () => false })
    expect(r).not.toBeNull()
    const content = JSON.parse(readFileSync(join(lockDir, lockName('rewrite', '跨进程书')), 'utf-8')) as { pid: number }
    expect(content.pid).toBe(process.pid)
    r!()
    // release 删锁文件：后续可再占
    expect(existsSync(join(lockDir, lockName('rewrite', '跨进程书')))).toBe(false)
  })

  it('正常占闸创建锁文件，release 后删除', () => {
    const r = acquireTaskGate('文件锁书', 'outline', { lockDir })
    expect(r).not.toBeNull()
    const p = join(lockDir, lockName('outline', '文件锁书'))
    expect(existsSync(p)).toBe(true)
    r!()
    expect(existsSync(p)).toBe(false)
  })

  it('锁文件损坏（空文件）→ 视同 stale 可接管', () => {
    writeFileSync(join(lockDir, lockName('autotag', '跨进程书')), '')
    const r = acquireTaskGate('跨进程书', 'autotag', { lockDir, isProcessAlive: () => true })
    expect(r).not.toBeNull()
    r!()
  })

  it('端点接线：书库 lockfile 在位（存活持有者）→ outline 409；删除 → 走通', async () => {
    // startServer 已把锁根注入 workDir/.clwriting/task-gate/——手写 BOOK 的 outline
    // 锁文件（pid=本进程=存活），验证端点闸在进程外锁在位时也拒 409（双进程互斥）
    const p = join(workDir, '.clwriting', 'task-gate', lockName('outline', BOOK))
    mkdirSync(dirname(p), { recursive: true })
    writeFileSync(p, JSON.stringify({ pid: process.pid, bootTime: Date.now() }))
    const busy = await req('POST', `/api/books/${encodeURIComponent(BOOK)}/outline`, { chapter: 1 })
    expect(busy.status).toBe(409)
    rmSync(p, { force: true })
    const ok = await req('POST', `/api/books/${encodeURIComponent(BOOK)}/outline`, { chapter: 1 })
    expect(ok.status).toBe(200)
  })
})

describe('端点并发闸接线（409）', () => {
  it('relations/mine 闸被持有 → 409；释放 → 非 409', async () => {
    const release = acquireTaskGate(BOOK, 'relations-mine')
    expect(release).not.toBeNull()
    const busy = await req('POST', `/api/books/${encodeURIComponent(BOOK)}/relations/mine`, { force: true })
    expect(busy.status).toBe(409)
    expect((busy.json as { error: string }).error).toContain('梳理')
    release!()
    // 释放后进 handler（无梳理材料 → 400，证明过了闸）
    const ok = await req('POST', `/api/books/${encodeURIComponent(BOOK)}/relations/mine`, { force: true })
    expect(ok.status).not.toBe(409)
  })

  it('outline 闸被持有 → 409；释放 → mock 走通 200', async () => {
    const release = acquireTaskGate(BOOK, 'outline')
    expect(release).not.toBeNull()
    const busy = await req('POST', `/api/books/${encodeURIComponent(BOOK)}/outline`, { chapter: 1 })
    expect(busy.status).toBe(409)
    release!()
    const ok = await req('POST', `/api/books/${encodeURIComponent(BOOK)}/outline`, { chapter: 1 })
    expect(ok.status).toBe(200)
    expect((ok.json as { ok: boolean }).ok).toBe(true)
  })

  // dd-P2：删书/改名在持闸时拒改——task-gate 任务无 abort 通道，
  // 放行会在收尾落盘时重建孤儿目录 / 写旧路径
  it('任意闸被持有 → 删书 409；释放 → 200', async () => {
    const release = acquireTaskGate(BOOK, 'rag-build')
    expect(release).not.toBeNull()
    const busy = await req('DELETE', `/api/books/${encodeURIComponent(BOOK)}`)
    expect(busy.status).toBe(409)
    expect((busy.json as { error: string }).error).toContain('rag-build')
    release!()
    const ok = await req('DELETE', `/api/books/${encodeURIComponent(BOOK)}`)
    expect(ok.status).toBe(200)
  })

  it('任意闸被持有 → 改名 409；释放 → 可改名（本测用书自建自删）', async () => {
    // 自建一本独立书，避免影响上方共享 BOOK 的用例顺序
    const NAME = '闸改名测试书'
    writeFileSync(
      join(workDir, '.clwriting', 'books.jsonl'),
      JSON.stringify({ name: BOOK, path: BOOK, kind: 'long' }) + '\n' +
        JSON.stringify({ name: NAME, path: `长篇/${NAME}`, kind: 'long' }) + '\n',
    )
    const bookRoot = join(workDir, '长篇', NAME)
    mkdirSync(join(bookRoot, '大纲'), { recursive: true })
    writeFileSync(join(bookRoot, 'book.yaml'), 'spec_version: 1\nkind: long\nbook:\n  title: 闸改名测试书\n  genre: 玄幻\nhost: cc\nleads:\n  enabled: []\n')

    const release = acquireTaskGate(NAME, 'analyze')
    expect(release).not.toBeNull()
    const busy = await req('POST', `/api/books/${encodeURIComponent(NAME)}/rename`, { name: '闸改名新名' })
    expect(busy.status).toBe(409)
    expect((busy.json as { error: string }).error).toContain('analyze')
    release!()
    const ok = await req('POST', `/api/books/${encodeURIComponent(NAME)}/rename`, { name: '闸改名新名' })
    expect(ok.status).toBe(200)
    expect((ok.json as { ok: boolean }).ok).toBe(true)
  })
})
