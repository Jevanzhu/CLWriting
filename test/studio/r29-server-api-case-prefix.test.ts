/**
 * D-4（二十九轮）回归：`/API/*` 大写前缀此前落 SPA 200。
 *
 * token 闸与路由分发都按小写 `/api/` 匹配——`/API/books` 双失配后落进静态分支，
 * 静态 miss 回退 SPA → 200 index.html（API 调用方拿到 HTML 当 JSON 解析）。
 * 修复后静态回退前按小写化口径兜一道：任意大小写 /api/ 前缀未匹配路由 → 404 JSON
 * 错误信封；/api/ 小写行为与静态托管行为均不变。
 */
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, afterAll, describe, it, expect } from 'vitest'
import { startServerSafe } from '../helpers/safe-port.js'

const BOOK = 'R29大写前缀书'
let workDir = ''
let staticDir = ''
let server: http.Server | undefined
let baseUrl = ''
let token = ''

interface Resp {
  status: number
  contentType: string
  text: string
}

function get(path: string, headers: Record<string, string> = {}): Promise<Resp> {
  return new Promise((resolve, reject) => {
    const u = new URL(baseUrl)
    http.request(
      { host: u.hostname, port: u.port, path, method: 'GET', headers },
      (res) => {
        let data = ''
        res.on('data', (c) => (data += c.toString('utf8')))
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, contentType: String(res.headers['content-type'] ?? ''), text: data }),
        )
      },
    )
      .on('error', reject)
      .end()
  })
}

beforeAll(async () => {
  workDir = mkdtempSync(join(tmpdir(), 'clw-r29-api-case-'))
  mkdirSync(join(workDir, '.clwriting'), { recursive: true })
  writeFileSync(
    join(workDir, '.clwriting', 'books.jsonl'),
    JSON.stringify({ name: BOOK, path: BOOK, kind: 'long' }) + '\n',
  )
  const bookRoot = join(workDir, BOOK)
  mkdirSync(bookRoot, { recursive: true })
  writeFileSync(
    join(bookRoot, 'book.yaml'),
    `spec_version: 1\nkind: long\nbook:\n  title: ${BOOK}\n  genre: 玄幻\nhost: cc\n`,
  )
  // 前端 dist 桩：只有 index.html——SPA fallback 可观测（miss 路径回 200 HTML）
  staticDir = mkdtempSync(join(tmpdir(), 'clw-r29-api-case-dist-'))
  writeFileSync(join(staticDir, 'index.html'), '<!doctype html><html><body>SPA</body></html>')
  server = await startServerSafe({ port: 0, workDir, staticDir })
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const r = await fetch(`${baseUrl}/api/boot`)
  token = ((await r.json()) as { token: string }).token
})

afterAll(async () => {
  if (server) await new Promise<void>((r) => server!.close(() => r()))
  if (workDir) rmSync(workDir, { recursive: true, force: true })
  if (staticDir) rmSync(staticDir, { recursive: true, force: true })
})

describe('D-4：/API/ 大写前缀不再落 SPA', () => {
  it('GET /API/xx → 404 JSON 错误信封（修复前 200 index.html）', async () => {
    const r = await get('/API/books')
    expect(r.status).toBe(404)
    expect(r.contentType).toContain('application/json')
    expect(JSON.parse(r.text)).toEqual({ code: 'NOT_FOUND', error: 'not found' })
    // 混合大小写同口径
    const mixed = await get('/Api/boot')
    expect(mixed.status).toBe(404)
    expect(mixed.contentType).toContain('application/json')
  })

  it('小写 /api/ 行为不变：/api/boot 放行、/api/books 带 token 200', async () => {
    const boot = await get('/api/boot')
    expect(boot.status).toBe(200)
    const books = await get('/api/books', { 'x-studio-token': token })
    expect(books.status).toBe(200)
    expect(books.contentType).toContain('application/json')
  })

  it('静态托管与 SPA fallback 不受影响：/ 与前端路由 miss 仍回 200 index.html', async () => {
    const root = await get('/')
    expect(root.status).toBe(200)
    expect(root.contentType).toContain('text/html')
    const spa = await get('/some/frontend/route')
    expect(spa.status).toBe(200)
    expect(spa.text).toContain('SPA')
  })
})
