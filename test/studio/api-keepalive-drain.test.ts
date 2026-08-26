/**
 * R64-28（十二轮）回归：dispatch 层 finish 后排空未消费请求体。
 *
 * 无 body POST 端点（heartbeat/style/rag/chat-branches 等）handler 不读 body 也不
 * resume——脚本客户端带 body 时，服务端不排空请求流就不会在同一 keep-alive socket
 * 上解析下一个请求（第二个请求悬挂直至客户端超时）。dispatch 层 finish 后统一
 * req.resume()（与 stream-ticket.ts:67 口径一致）。
 */
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, afterAll, describe, it, expect } from 'vitest'
import { startServer } from '../../src/studio/server/index.js'

const BOOK = '排空测试书'
let workDir = ''
let server: http.Server | undefined
let baseUrl = ''
let token = ''

beforeAll(async () => {
  workDir = mkdtempSync(join(tmpdir(), 'clwriting-keepalive-'))
  mkdirSync(join(workDir, '.clwriting'), { recursive: true })
  writeFileSync(
    join(workDir, '.clwriting', 'books.jsonl'),
    JSON.stringify({ name: BOOK, path: BOOK, kind: 'long' }) + '\n',
  )
  mkdirSync(join(workDir, BOOK, '项目'), { recursive: true })
  writeFileSync(join(workDir, BOOK, 'book.yaml'), 'spec_version: 1\nkind: long\nbook:\n  title: 排空测试书\nhost: cc\n', 'utf8')
  server = startServer({ port: 0, workDir })
  await new Promise<void>((r) => server!.once('listening', r))
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const r = await fetch(`${baseUrl}/api/boot`)
  token = ((await r.json()) as { token: string }).token
})

afterAll(async () => {
  if (server) await new Promise<void>((r) => server!.close(() => r()))
  if (workDir) rmSync(workDir, { recursive: true, force: true })
})

/** 同一 keep-alive agent 上带 body 的 POST；记录用到的 socket 以断言复用 */
function postHeartbeat(agent: http.Agent, sockets: Set<net_Socket>): Promise<number> {
  return new Promise((resolve, reject) => {
    const u = new URL(baseUrl)
    const payload = JSON.stringify({ padding: 'x'.repeat(512) })
    const r = http.request(
      {
        host: u.hostname,
        port: u.port,
        path: `/api/books/${encodeURIComponent(BOOK)}/heartbeat`,
        method: 'POST',
        agent,
        headers: {
          'x-studio-token': token,
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(payload),
        },
      },
      (res) => {
        // 消费响应体（keep-alive 复用的另一半前提）
        res.resume()
        res.on('end', () => resolve(res.statusCode ?? 0))
      },
    )
    r.on('socket', (s) => sockets.add(s))
    r.on('error', reject)
    r.end(payload)
  })
}

// 最小类型桩：只用到 socket 身份（Set 判重）
interface net_Socket {
  remotePort?: number
}

describe('R64-28：finish 后排空未消费请求体（keep-alive 可复用）', () => {
  it('带 body 连打两次无 body POST → 两次都 200 且复用同一 socket', async () => {
    const agent = new http.Agent({ keepAlive: true, maxSockets: 1 })
    const sockets = new Set<net_Socket>()
    try {
      const s1 = await postHeartbeat(agent, sockets)
      expect(s1).toBe(200)
      // 修复前：第一个请求的 body 未排空，第二个请求在同 socket 上不被解析（悬挂）
      const s2 = await Promise.race([
        postHeartbeat(agent, sockets),
        new Promise<never>((_, rej) => setTimeout(() => rej(new Error('第二个请求悬挂：请求体未排空')), 5000)),
      ])
      expect(s2).toBe(200)
      expect(sockets.size).toBe(1) // 同一 socket 承载两次请求
    } finally {
      agent.destroy()
    }
  })
})
