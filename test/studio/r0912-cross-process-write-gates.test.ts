/**
 * R0912-P2-疑似（2026-09-11 重评-0911c 修复批）回归：/spawn、/auto-write、/chat 三处
 * 生成任务闸此前只查纯进程内 heldTaskGatesFor——双进程形态（dev-api/脚本与 GUI 并存）下
 * 他进程分钟级任务在途时照常放行，写手/对话与任务收尾互踩产出。修复后换
 * allHeldTaskGatesFor（books.ts busyGate R75-5 同款：进程内 Set + 跨进程锁文件扫描去重）。
 *
 * 端点接线路径参照 r75-cross-process-busy-gate.test.ts：startServer 已把锁根注入
 * workDir/.clwriting/task-gate/——手写他进程在持锁文件（活 pid 载荷）模拟「另一进程正持
 * 闸」；陈锁（活 pid 超龄无续期）不算在持（放行）。
 */
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createHash } from 'node:crypto'
import { beforeAll, afterAll, describe, it, expect } from 'vitest'
import { startServerSafe } from '../helpers/safe-port.js'

// 复现锁文件名算法（sha256(key) 前 16 hex；key = action + NUL + book）——与 task-gate.ts 同源约定
const gateKey = (action: string, book: string): string => `${action}\u0000${book}`
const lockName = (action: string, book: string): string =>
  `${createHash('sha256').update(gateKey(action, book)).digest('hex').slice(0, 16)}.lock`

const BOOK = 'R0912跨进程写闸书'
let workDir = ''
let server: http.Server | undefined
let baseUrl = ''
let token = ''
const prevDriver = process.env['CLWRITING_DRIVER']

function req(method: string, path: string, body?: unknown): Promise<{ status: number; json: unknown }> {
  return new Promise((resolve, reject) => {
    const u = new URL(baseUrl)
    const payload = body !== undefined ? JSON.stringify(body) : ''
    const r = http.request(
      {
        host: u.hostname,
        port: u.port,
        path,
        method,
        headers: {
          'x-studio-token': token,
          origin: baseUrl,
          ...(payload ? { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(payload)) } : {}),
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

/** 在锁根写一枚他进程在持锁文件（活 pid = 本进程，探测必活——等价他进程在持）。 */
function holdCrossProcessGate(action: string, book: string): string {
  const lockPath = join(workDir, '.clwriting', 'task-gate', lockName(action, book))
  mkdirSync(dirname(lockPath), { recursive: true })
  writeFileSync(lockPath, JSON.stringify({ pid: process.pid, bootTime: Date.now() }))
  return lockPath
}

beforeAll(async () => {
  process.env['CLWRITING_DRIVER'] = 'mock' // 放行臂走 spawn mock 快路，不起真实生成
  workDir = mkdtempSync(join(tmpdir(), 'clw-r0912-xgate-'))
  mkdirSync(join(workDir, '.clwriting'), { recursive: true })
  writeFileSync(
    join(workDir, '.clwriting', 'books.jsonl'),
    JSON.stringify({ name: BOOK, path: BOOK, kind: 'long' }) + '\n',
  )
  const bookRoot = join(workDir, BOOK)
  mkdirSync(join(bookRoot, '写作', '正文'), { recursive: true })
  writeFileSync(
    join(bookRoot, 'book.yaml'),
    ['spec_version: 1', 'book:', `  title: ${BOOK}`, '  genre: 玄幻'].join('\n') + '\n',
    'utf-8',
  )
  mkdirSync(join(workDir, 'userData'), { recursive: true })
  server = await startServerSafe({ port: 0, workDir, userDataPath: join(workDir, 'userData') })
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const boot = await (await fetch(`${baseUrl}/api/boot`)).json()
  token = (boot as { token: string }).token
})

afterAll(async () => {
  if (server) await new Promise<void>((r) => server!.close(() => r()))
  rmSync(workDir, { recursive: true, force: true })
  if (prevDriver === undefined) delete process.env['CLWRITING_DRIVER']
  else process.env['CLWRITING_DRIVER'] = prevDriver
})

describe('R0912-P2-疑似: /spawn、/auto-write、/chat 任务闸含跨进程面', () => {
  it('他进程 outline 闸在持 → /spawn 409（文案含 action）；锁删除后放行 200', async () => {
    const lockPath = holdCrossProcessGate('outline', BOOK)
    try {
      const busy = await req('POST', `/api/books/${encodeURIComponent(BOOK)}/spawn`, { role: 'writer', prompt: '写第一章' })
      expect(busy.status).toBe(409)
      expect((busy.json as { code?: string }).code).toBe('BUSY')
      expect(String((busy.json as { error?: string }).error)).toContain('outline')
    } finally {
      rmSync(lockPath, { force: true })
    }
    const ok = await req('POST', `/api/books/${encodeURIComponent(BOOK)}/spawn`, { role: 'writer', prompt: '写第一章' })
    expect(ok.status).toBe(200)
  })

  it('他进程陈锁（活 pid 超龄无续期）→ 不算在持，/spawn 照常放行', async () => {
    const lockPath = holdCrossProcessGate('analyze', BOOK)
    const past = new Date(Date.now() - 11 * 60_000)
    utimesSync(lockPath, past, past) // 持有 pid 活着但锁龄超 Z-19 的 10min 线 → 陈锁
    const ok = await req('POST', `/api/books/${encodeURIComponent(BOOK)}/spawn`, { role: 'writer', prompt: '写第一章' })
    expect(ok.status).toBe(200)
  })

  it('他进程 lead-updates 闸在持 → /auto-write 409（首检即拦，不进 chapter 校验）', async () => {
    const lockPath = holdCrossProcessGate('lead-updates', BOOK)
    try {
      const busy = await req('POST', `/api/books/${encodeURIComponent(BOOK)}/auto-write`, {})
      expect(busy.status).toBe(409)
      expect(String((busy.json as { error?: string }).error)).toContain('lead-updates')
    } finally {
      rmSync(lockPath, { force: true })
    }
  })

  it('他进程 analyze 闸在持 → /chat 409（闸先于 sendChatMessage）', async () => {
    const lockPath = holdCrossProcessGate('analyze', BOOK)
    try {
      // chat.send 有 parse（message 必填 → 400 在 handler 之前）——body 须过 parse 才能到达闸
      const busy = await req('POST', `/api/books/${encodeURIComponent(BOOK)}/chat`, { message: '你好' })
      expect(busy.status).toBe(409)
      expect(String((busy.json as { error?: string }).error)).toContain('analyze')
    } finally {
      rmSync(lockPath, { force: true })
    }
  })
})
