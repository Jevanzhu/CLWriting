/**
 * Y-10（第五十七轮）回归——search 端点 URL 解析收编 parseRequestUrl。
 *
 * search.ts 此前是 api 层唯一残留的裸 `new URL`（R-19 收编漏网点）——handler 级
 * 畸形 URL 分支依赖 router 前置 parse 兜底，属口径漂移死分叉；本次换 parseRequestUrl
 * + 400 BAD_INPUT 与全库同口径。线上行为回归：正常查询 200 + 结果形状不回退。
 */
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, afterAll, it, expect } from 'vitest'
import { startServer } from '../../src/studio/server/index.js'

let baseUrl = ''
let server: http.Server | undefined
let token = ''
const workDir = mkdtempSync(join(tmpdir(), 'clw-y10-'))

function get(path: string, headers: Record<string, string> = {}): Promise<{ status: number; text: string }> {
  return new Promise((resolve) => {
    const u = new URL(baseUrl)
    const req = http.request({ host: u.hostname, port: u.port, path, method: 'GET', headers }, (res) => {
      let data = ''
      res.on('data', (c) => (data += c.toString('utf8')))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, text: data }))
    })
    req.on('error', () => resolve({ status: 0, text: '' }))
    req.end()
  })
}

beforeAll(async () => {
  // 夹具书：一章含可搜文本
  const bookRoot = join(workDir, '书Y10')
  mkdirSync(join(bookRoot, '写作', '正文'), { recursive: true })
  writeFileSync(join(bookRoot, 'book.yaml'), '标题: 书Y10\n')
  writeFileSync(join(bookRoot, '写作', '正文', '0001-开篇.md'), '---\n章号: 1\n标题: 开篇\n---\n\n山门外玉佩轻响。')
  server = startServer({ workDir, port: 0, userDataPath: null })
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r))
  const addr = server.address() as AddressInfo
  baseUrl = `http://127.0.0.1:${addr.port}`
  const boot = await get('/api/boot')
  token = ((JSON.parse(boot.text) as { token?: string }).token) ?? ''
})

afterAll(() => {
  server?.close()
  rmSync(workDir, { recursive: true, force: true })
})

it('search 正常查询：200 + 命中行（parseRequestUrl 换轨不回退）', async () => {
  const r = await get(`/api/books/${encodeURIComponent('书Y10')}/search?q=${encodeURIComponent('玉佩')}`, {
    'x-studio-token': token,
  })
  expect(r.status).toBe(200)
  const body = JSON.parse(r.text) as { results: Array<{ path: string; matches: Array<{ line: number; text: string }> }> }
  expect(body.results.length).toBeGreaterThan(0)
  expect(body.results[0]!.matches.length).toBeGreaterThan(0)
})
