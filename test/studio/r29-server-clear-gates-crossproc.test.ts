/**
 * R29-9（二十九轮）回归：清史（DELETE /audit）与清空对话（POST /chat/clear）的
 * 跨进程任务闸查询缺口。
 *
 * 两处此前只查 heldTaskGatesFor（进程内 Set）——双进程形态（dev-api/脚本与 GUI 并存）
 * 下，B 进程分钟级任务在途时 A 进程清史/清空放行，任务收尾继续向已清 session 追加
 * 事件（清不彻底）。修复后两处换 allHeldTaskGatesFor（books.ts busyGate R75-5 同口径：
 * 进程内 Set ∪ 跨进程锁文件扫描，Set 去重）：
 *
 * - 单元：allHeldTaskGatesFor 合并去重（本进程闸两侧都在 → 单项）；
 * - 端点：进程内真实占闸 → 两端点 409；手写他进程活锁文件 → 两端点 409（文案含
 *   action）；锁删除后放行 200（不误伤）。
 * 跨进程锁伪造先例：r75-cross-process-busy-gate.test.ts。
 */
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createHash } from 'node:crypto'
import { beforeAll, afterAll, describe, it, expect } from 'vitest'
import { startServerSafe } from '../helpers/safe-port.js'
import { acquireTaskGate } from '../../src/studio/server/api/task-gate.js'
import { allHeldTaskGatesFor } from '../../src/studio/server/api/audit.js'

// 复现锁文件名算法（sha256(key) 前 16 hex；key = action + NUL + book）——与 task-gate.ts 同源约定
const lockName = (action: string, book: string): string =>
  `${createHash('sha256').update(`${action}\u0000${book}`).digest('hex').slice(0, 16)}.lock`

const BOOK = 'R29清史闸书'
let workDir = ''
let userDataPath = ''
let server: http.Server | undefined
let baseUrl = ''
let token = ''

function req(method: string, path: string): Promise<{ status: number; json: unknown }> {
  return new Promise((resolve, reject) => {
    const u = new URL(baseUrl)
    const r = http.request(
      {
        host: u.hostname,
        port: u.port,
        path,
        method,
        headers: { 'x-studio-token': token, origin: baseUrl },
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
    r.end()
  })
}

/** 手写「他进程在持」的活 pid 锁文件（本进程 pid 探测必活，等价他进程在持）。 */
function forgeLock(action: string, book: string): string {
  const lockPath = join(workDir, '.clwriting', 'task-gate', lockName(action, book))
  mkdirSync(dirname(lockPath), { recursive: true })
  writeFileSync(lockPath, JSON.stringify({ pid: process.pid, bootTime: Date.now() }))
  return lockPath
}

beforeAll(async () => {
  workDir = mkdtempSync(join(tmpdir(), 'clw-r29-clear-gates-'))
  userDataPath = mkdtempSync(join(tmpdir(), 'clw-r29-clear-gates-ud-'))
  mkdirSync(join(workDir, '.clwriting'), { recursive: true })
  writeFileSync(
    join(workDir, '.clwriting', 'books.jsonl'),
    JSON.stringify({ name: BOOK, path: BOOK, kind: 'long' }) + '\n',
  )
  const bookRoot = join(workDir, BOOK)
  mkdirSync(bookRoot, { recursive: true })
  writeFileSync(
    join(bookRoot, 'book.yaml'),
    'spec_version: 1\nkind: long\nbook:\n  title: R29清史闸书\n  genre: 玄幻\nhost: cc\n',
  )
  server = await startServerSafe({ port: 0, workDir, userDataPath })
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const r = await fetch(`${baseUrl}/api/boot`)
  token = ((await r.json()) as { token: string }).token
})

afterAll(async () => {
  if (server) await new Promise<void>((r) => server!.close(() => r()))
  if (workDir) rmSync(workDir, { recursive: true, force: true })
  if (userDataPath) rmSync(userDataPath, { recursive: true, force: true })
})

describe('R29-9：清史/清空对话跨进程任务闸', () => {
  it('单元：allHeldTaskGatesFor 合并进程内 Set 与锁文件扫描并去重', () => {
    const release = acquireTaskGate(BOOK, 'analyze')!
    try {
      // 本进程闸两侧都在（Set + startServer 注入锁根下的锁文件）→ 去重后单项
      expect(allHeldTaskGatesFor(BOOK)).toEqual(['analyze'])
      // 别的书不受影响
      expect(allHeldTaskGatesFor('别的书')).toEqual([])
    } finally {
      release()
    }
    expect(allHeldTaskGatesFor(BOOK)).toEqual([])
  })

  it('进程内闸命中 → 清史/清空对话 409（文案含 action）', async () => {
    const release = acquireTaskGate(BOOK, 'analyze')!
    try {
      const audit = await req('DELETE', `/api/books/${encodeURIComponent(BOOK)}/audit`)
      expect(audit.status).toBe(409)
      expect((audit.json as { error: string }).error).toContain('任务在跑')
      const clear = await req('POST', `/api/books/${encodeURIComponent(BOOK)}/chat/clear`)
      expect(clear.status).toBe(409)
      expect((clear.json as { error: string }).error).toContain('任务在跑')
    } finally {
      release()
    }
  })

  it('跨进程锁文件在持（活 pid）→ 清史/清空对话 409；锁删除后放行 200', async () => {
    // 旧行为本进程 Set 看不见他进程锁——放行清库后任务收尾事件复活到已清 session
    const lockPath = forgeLock('rag-build', BOOK)
    try {
      expect(allHeldTaskGatesFor(BOOK)).toEqual(['rag-build']) // 锁文件扫描可见
      const audit = await req('DELETE', `/api/books/${encodeURIComponent(BOOK)}/audit`)
      expect(audit.status).toBe(409)
      expect((audit.json as { error: string }).error).toContain('rag-build')
      const clear = await req('POST', `/api/books/${encodeURIComponent(BOOK)}/chat/clear`)
      expect(clear.status).toBe(409)
      expect((clear.json as { error: string }).error).toContain('rag-build')
    } finally {
      rmSync(lockPath, { force: true })
    }
    // 锁删除后不误伤：两端点放行（清史清空各自的正常出口）
    const clear = await req('POST', `/api/books/${encodeURIComponent(BOOK)}/chat/clear`)
    expect(clear.status).toBe(200)
    const audit = await req('DELETE', `/api/books/${encodeURIComponent(BOOK)}/audit`)
    expect(audit.status).toBe(200)
  })
})
