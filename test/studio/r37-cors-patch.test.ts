/**
 * R37-18（三十七轮批 D）回归：CORS 预检 allow-methods 补 PATCH。
 *
 * 修复前：access-control-allow-methods 缺 PATCH——服务端写闸（isWrite）本就把 PATCH
 * 纳入 Origin/token 校验，但浏览器对 PATCH（非简单方法）先发 OPTIONS 预检，清单不含
 * PATCH → 预检后实际请求仍被浏览器按 CORS 拒发（服务端放行口径与预检清单失配）。
 *
 * 夹具口径同 api-cors.test.ts：手动 http.request 发 OPTIONS（可设任意 Origin），
 * 同源（实际监听 origin，listening 后自动入白名单）→ 预检 204 + 头回执。
 */
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, afterAll, describe, it, expect } from 'vitest'
import { startServerSafe } from '../helpers/safe-port.js'

let workDir = ''
let server: http.Server | undefined
let baseUrl = ''

/** 手动发 OPTIONS 预检（绕过 fetch 对 Origin 的 forbidden header 限制），回收放行方法头。 */
function preflight(origin: string): Promise<{ status: number; methods: string | null }> {
  return new Promise((resolve) => {
    const u = new URL(baseUrl)
    const req = http.request(
      { host: u.hostname, port: u.port, path: '/api/books', method: 'OPTIONS', headers: { origin } },
      (res) => {
        res.resume()
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, methods: (res.headers['access-control-allow-methods'] as string | undefined) ?? null }),
        )
      },
    )
    req.on('error', () => resolve({ status: 0, methods: null }))
    req.end()
  })
}

beforeAll(async () => {
  workDir = mkdtempSync(join(tmpdir(), 'clwriting-r37-cors-'))
  mkdirSync(join(workDir, '.clwriting'), { recursive: true })
  writeFileSync(join(workDir, '.clwriting', 'books.jsonl'), JSON.stringify({ name: '测试书', path: '测试书', kind: 'long' }) + '\n')
  const bookRoot = join(workDir, '测试书')
  mkdirSync(join(bookRoot, '大纲'), { recursive: true })
  writeFileSync(join(bookRoot, 'book.yaml'), 'spec_version: 1\nbook:\n  title: 测试书\n  genre: 仙侠\nkind: long\nhost: cc\n')
  writeFileSync(join(bookRoot, '大纲', '总纲.md'), '# 总纲')

  server = await startServerSafe({ port: 0, workDir })
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(async () => {
  if (server) await new Promise<void>((r) => server!.close(() => r()))
  if (workDir) rmSync(workDir, { recursive: true, force: true })
})

describe('R37-18 CORS allow-methods 含 PATCH', () => {
  it('同源 OPTIONS 预检 → 204 且 allow-methods 含 PATCH（含既有 GET/POST/PUT/DELETE/OPTIONS）', async () => {
    const r = await preflight(baseUrl)
    expect(r.status).toBe(204)
    expect(r.methods).not.toBeNull()
    const methods = r.methods!.split(',').map((s) => s.trim())
    expect(methods).toContain('PATCH')
    for (const m of ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS']) expect(methods).toContain(m)
  })

  it('恶意 Origin 预检仍拒（403，安全口径不随清单扩充放宽）', async () => {
    const r = await preflight('http://evil.com')
    expect(r.status).toBe(403)
  })
})
