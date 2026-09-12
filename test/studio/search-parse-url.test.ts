/**
 * Y-10（第五十七轮）回归——search 端点 URL 解析收编 parseRequestUrl。
 *
 * search.ts 此前是 api 层唯一残留的裸 `new URL`（R-19 收编漏网点）——handler 级
 * 畸形 URL 分支依赖 router 前置 parse 兜底，属口径漂移死分叉；本次换 parseRequestUrl
 * + 400 BAD_INPUT 与全库同口径。线上行为回归：正常查询 200 + 结果形状不回退。
 *
 * 测试精简批（2026-09-12）：启动样板收编 bootStudio 空书架形态（get 走裸 http.request 定制
 * 形态保留本地；不写 books.jsonl 维持「启动扫描自愈登记」原形态；原显式 userDataPath:null
 * 与缺省在服务端 ?? null 归一等价）。
 */
import http from 'node:http'
import { beforeAll, afterAll, it, expect } from 'vitest'
import { bootStudio, type StudioHarness } from '../helpers/studio-server.js'

let studio: StudioHarness
let token = ''

function get(path: string, headers: Record<string, string> = {}): Promise<{ status: number; text: string }> {
  return new Promise((resolve) => {
    const u = new URL(studio.baseUrl)
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
  studio = await bootStudio({
    prefix: 'clw-y10-',
    dirs: ['书Y10/写作/正文'],
    files: [
      { rel: '书Y10/book.yaml', content: '标题: 书Y10\n' },
      { rel: '书Y10/写作/正文/0001-开篇.md', content: '---\n章号: 1\n标题: 开篇\n---\n\n山门外玉佩轻响。' },
    ],
  })
  token = studio.token
})

afterAll(() => studio.close())

it('search 正常查询：200 + 命中行（parseRequestUrl 换轨不回退）', async () => {
  const r = await get(`/api/books/${encodeURIComponent('书Y10')}/search?q=${encodeURIComponent('玉佩')}`, {
    'x-studio-token': token,
  })
  expect(r.status).toBe(200)
  const body = JSON.parse(r.text) as { results: Array<{ path: string; matches: Array<{ line: number; text: string }> }> }
  expect(body.results.length).toBeGreaterThan(0)
  expect(body.results[0]!.matches.length).toBeGreaterThan(0)
})
