/**
 * P0 CORS 安全边界测(横切评审 GPT-5 P0):防 localhost 跨站调用。
 *
 * Origin 白名单:同源 + dev Vite(5173)。写端点(POST/PUT/DELETE)+ OPTIONS 预检
 * 非白名单 Origin → 403。GET 跨站无 ACAO(浏览器拒读)。
 */
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, afterAll, describe, it, expect } from 'vitest'
import { startServer } from '../../src/studio/server/index.js'

let workDir = ''
let server: http.Server | undefined
let baseUrl = ''

/** 手动发 HTTP 请求(可设任意 Origin header,绕过 fetch forbidden header 限制) */
function rawRequest(method: string, path: string, origin: string | null): Promise<{ status: number; acao: string | null }> {
  return new Promise((resolve) => {
    const u = new URL(baseUrl)
    const req = http.request(
      { host: u.hostname, port: u.port, path, method, headers: origin ? { origin } : {} },
      (res) => {
        res.resume()
        res.on('end', () => resolve({ status: res.statusCode ?? 0, acao: res.headers['access-control-allow-origin'] ?? null }))
      },
    )
    req.on('error', () => resolve({ status: 0, acao: null }))
    req.end()
  })
}

beforeAll(async () => {
  workDir = mkdtempSync(join(tmpdir(), 'clwriting-cors-'))
  mkdirSync(join(workDir, '.clwriting'), { recursive: true })
  writeFileSync(join(workDir, '.clwriting', 'books.jsonl'), JSON.stringify({ name: '测试书', path: '测试书', kind: 'long' }) + '\n')
  const bookRoot = join(workDir, '测试书')
  mkdirSync(join(bookRoot, '大纲'), { recursive: true })
  writeFileSync(join(bookRoot, 'book.yaml'), 'spec_version: 1\nbook:\n  title: 测试书\n  genre: 仙侠\nkind: long\nhost: cc\n')
  writeFileSync(join(bookRoot, '大纲', '总纲.md'), '# 总纲')

  server = startServer({ port: 0, workDir })
  await new Promise<void>((r) => server!.once('listening', r))
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(async () => {
  if (server) await new Promise<void>((r) => server!.close(() => r()))
  if (workDir) rmSync(workDir, { recursive: true, force: true })
})

describe('P0 CORS 安全边界', () => {
  it('GET 无 Origin(curl/同源)→ 200 放行', async () => {
    const r = await rawRequest('GET', '/api/books', null)
    expect(r.status).toBe(200)
  })

  it('GET 恶意 Origin → 200 但无 ACAO header(浏览器拒读)', async () => {
    const r = await rawRequest('GET', '/api/books', 'http://evil.com')
    expect(r.status).toBe(200)
    expect(r.acao).toBeNull()
  })

  it('GET 白名单 Origin → 200 + ACAO 回显', async () => {
    const r = await rawRequest('GET', '/api/books', baseUrl)
    expect(r.status).toBe(200)
    expect(r.acao).toBe(baseUrl)
  })

  it('PUT 恶意 Origin → 403(防跨站写)', async () => {
    const r = await rawRequest('PUT', `/api/books/${encodeURIComponent('测试书')}/settings/character`, 'http://evil.com')
    expect(r.status).toBe(403)
  })

  it('POST 恶意 Origin → 403', async () => {
    const r = await rawRequest('POST', `/api/books/${encodeURIComponent('测试书')}/cli`, 'http://evil.com')
    expect(r.status).toBe(403)
  })

  it('OPTIONS 恶意 Origin → 403(预检拒)', async () => {
    const r = await rawRequest('OPTIONS', '/api/books', 'http://evil.com')
    expect(r.status).toBe(403)
  })

  it('OPTIONS 白名单 Origin → 204(预检过)', async () => {
    const r = await rawRequest('OPTIONS', '/api/books', baseUrl)
    expect(r.status).toBe(204)
  })
})
