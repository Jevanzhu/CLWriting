/**
 * 未命中 /api 前缀 → 404 JSON 错误信封（不落 SPA 200 HTML）。
 *
 * 合并自两份同型回归（2026-09-26 测试资产行为化批，按被测行为归并；去重 SPA-200
 * 对照 1 处、大小写臂并入表驱动，7 用例 → 4 用例，断言面全覆盖）：
 * - D-4（二十九轮，原 test/studio/r29-server-api-case-prefix.test.ts）：`/API/*`
 *   大写前缀此前落 SPA 200——token 闸与路由分发都按小写 `/api/` 匹配，`/API/books`
 *   双失配后落进静态分支，静态 miss 回退 SPA → 200 index.html（API 调用方拿到 HTML
 *   当 JSON 解析）。修复后静态回退前按小写化口径兜一道。
 * - R35-30（三十五轮，原 test/studio/r35-api-prefix-404.test.ts）：裸 `/api`（无尾
 *   斜杠）同型失守的最后一档——apiPathname 判定 startsWith('/api/') 不含精确 '/api'。
 *   修复后任意大小写精确 '/api' 与 '/api/xxx' 未命中同回 404 JSON 信封。
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
  // 缺省附 token（R35-30 原口径）：小写 /api 未命中路由须过 token 闸后由路由 404，
  // 无凭据会被 token 闸抢先 403 掩盖断言面
  const withToken = { 'x-studio-token': token, ...headers }
  return new Promise((resolve, reject) => {
    const u = new URL(baseUrl)
    http.request(
      { host: u.hostname, port: u.port, path, method: 'GET', headers: withToken },
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
  workDir = mkdtempSync(join(tmpdir(), 'clw-api-prefix-404-'))
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
  staticDir = mkdtempSync(join(tmpdir(), 'clw-api-prefix-404-dist-'))
  writeFileSync(join(staticDir, 'index.html'), '<!doctype html><html><title>SPA</title><body>SPA</body></html>')
  server = await startServerSafe({ port: 0, workDir, staticDir })
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const r = await fetch(`${baseUrl}/api/boot`)
  token = ((await r.json()) as { token: string }).token
})

afterAll(async () => {
  // R46-12（四十六轮）：静态 GET 改 createReadStream 后 keep-alive 连接不再随
  // res.end 即刻回收，afterAll 的 server.close() 会等满 keepAlive 超时（hook 10s 红门）
  // ——先 closeAllConnections 再 close（static-branch-error.test 同款收尾）
  server?.closeAllConnections?.()
  if (server) await new Promise<void>((r) => server!.close(() => r()))
  if (workDir) rmSync(workDir, { recursive: true, force: true })
  if (staticDir) rmSync(staticDir, { recursive: true, force: true })
})

describe('未命中 /api 前缀 → 404 JSON 错误信封（不落 SPA）', () => {
  // 表驱动：裸 /api（R35-30）/ 大写与混合大小写前缀（D-4）/ 小写未命中路由（既有行为）
  const misses = ['/api', '/API', '/API/books', '/Api/boot', '/api/nonexistent', '/api/nonexistent/deeper']

  it.each(misses)('GET %s → 404 application/json（修复前落 SPA 200 index.html）', async (p) => {
    const r = await get(p)
    expect(r.status).toBe(404)
    expect(r.contentType).toContain('application/json')
    expect(JSON.parse(r.text)).toMatchObject({ code: 'NOT_FOUND' })
  })

  it('错误信封形状逐字：/API/books → { code: NOT_FOUND, error: not found }', async () => {
    const r = await get('/API/books')
    expect(JSON.parse(r.text)).toEqual({ code: 'NOT_FOUND', error: 'not found' })
  })
})

describe('低风险回归面：小写 /api 与静态托管行为不变', () => {
  it('小写 /api/ 放行：/api/boot 200、/api/books 带 token 200 application/json', async () => {
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
    expect(spa.contentType).toContain('text/html')
    expect(spa.text).toContain('SPA')
  })
})
