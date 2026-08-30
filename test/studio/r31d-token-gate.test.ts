/**
 * R31-4（三十一轮）回归——GET/HEAD token 闸与 dispatch 的 /api/ 判定口径统一。
 *
 * 原闸用 raw `req.url.startsWith('/api/')`：llhttp 不归一化请求行，`GET /foo/../api/books`
 * 的 raw url 不含 `/api/` 前缀 → 跳过 token 闸，而 apiPathname（WHATWG URL 归一化点段，
 * 含 `%2e%2e`）命中 `/api/` → 无凭据进路由——R65-64「全量 GET 无凭据一律 403」的
 * 自定目标失守。修复后闸改用规范化 apiPathname。
 *
 * 约定沿 api-token.test.ts（X-35）：断言 token 闸必须走 raw 通道（node:http 直发路径 /
 * raw socket 请求行），fetch 会被全局 setup 包装注入 token 造成假绿。
 */
import http from 'node:http'
import net from 'node:net'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, afterAll, describe, it, expect } from 'vitest'
import { startServer } from '../../src/studio/server/index.js'

let baseUrl = ''
let server: http.Server | undefined
let token = ''
let workDir = ''

function rawRequest(method: string, path: string, headers: Record<string, string> = {}): Promise<{ status: number; text: string }> {
  return new Promise((resolve) => {
    const u = new URL(baseUrl)
    const req = http.request({ host: u.hostname, port: u.port, path, method, headers }, (res) => {
      let data = ''
      res.on('data', (c) => (data += c.toString('utf8')))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, text: data }))
    })
    req.on('error', () => resolve({ status: 0, text: '' }))
    req.end()
  })
}

/** raw socket 直发请求行（不经任何客户端归一化） */
function rawSocketRequestLine(requestLine: string): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const address = server!.address() as AddressInfo
    const sock = net.connect(address.port, '127.0.0.1')
    const timer = setTimeout(() => reject(new Error('2s 内无响应')), 2_000)
    sock.on('connect', () => {
      sock.write(`${requestLine}\r\nHost: 127.0.0.1:${address.port}\r\n\r\n`)
    })
    sock.on('data', (d) => {
      clearTimeout(timer)
      const raw = d.toString('utf8')
      const statusLine = raw.split('\r\n')[0] ?? ''
      sock.destroy()
      resolve({ status: Number(statusLine.split(' ')[1] ?? 0), text: raw })
    })
    sock.on('error', (e) => {
      clearTimeout(timer)
      reject(e)
    })
  })
}

beforeAll(async () => {
  workDir = mkdtempSync(join(tmpdir(), 'clwriting-r31d-'))
  mkdirSync(join(workDir, '.clwriting'), { recursive: true })
  mkdirSync(join(workDir, 't'), { recursive: true })
  writeFileSync(join(workDir, '.clwriting', 'books.jsonl'), '{"name":"t","path":"t"}\n')
  server = startServer({ port: 0, workDir })
  await new Promise<void>((r) => server!.once('listening', r))
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const r = await fetch(`${baseUrl}/api/boot`)
  const d = (await r.json()) as { token: string }
  token = d.token
})

afterAll(async () => {
  if (server) await new Promise<void>((r) => server!.close(() => r()))
  if (workDir) rmSync(workDir, { recursive: true, force: true })
})

describe('R31-4：dot-segment 不绕读闸', () => {
  it('GET /foo/../api/books 无凭据 → 403（修复前 200）', async () => {
    const r = await rawRequest('GET', '/foo/../api/books')
    expect(r.status).toBe(403)
  })

  it('raw socket GET /x/%2e%2e/api/books 无凭据 → 403（编码点段同效）', async () => {
    const r = await rawSocketRequestLine('GET /x/%2e%2e/api/books')
    expect(r.status).toBe(403)
  })

  it('对照：规范化 /api/books 无凭据 → 403（读闸本体未回归）', async () => {
    const r = await rawRequest('GET', '/api/books')
    expect(r.status).toBe(403)
  })

  it('对照：dot-segment + 凭据 → 200（闸只拦无凭据，不拦合法读）', async () => {
    const r = await rawRequest('GET', '/foo/../api/books', { 'x-studio-token': token })
    expect(r.status).toBe(200)
  })
})
