/**
 * req.url → URL 统一安全解析（parseRequestUrl）行为面：
 *
 * 六处 handler 裸调 `new URL(req.url, base)` 此前各管各；畸形请求行（llhttp 接受的
 * absolute-form，如 `GET http://[bad HTTP/1.1`）会让 new URL 抛 TypeError。收编后
 * 畸形 URL 返 null → 调用方回 400 BAD_INPUT 信封（与 static.ts 静态分支同款）；
 * router.ts dispatch 同源接入（此前裸抛落外层 catch 变 500）。
 *
 * 同域并入（各自测试面独立、夹具自建自清）：
 * - 路由模板路径段括号转义（router.ts createRouteTable 模板编译）；
 * - search 端点 URL 解析换轨 parseRequestUrl（handler 不再裸 new URL）。
 */
import http, { createServer, type Server } from 'node:http'
import net from 'node:net'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { parseRequestUrl } from '../../../src/studio/server/http.js'
import { createRouteTable, withRouteTable, route, dispatch } from '../../../src/studio/server/router.js'
import { bootStudio, type StudioHarness } from '../../helpers/studio-server.js'
import { listenSafe } from '../../helpers/safe-port.js'

function fakeReq(url: string | undefined): { url: string | undefined } {
  return { url }
}

describe('R-19: parseRequestUrl 单元', () => {
  it('正常路径/query → URL 对象', () => {
    const u = parseRequestUrl(fakeReq('/api/books/x/foreshadows?q=%E7%8E%89') as never)
    expect(u).not.toBeNull()
    expect(u!.pathname).toBe('/api/books/x/foreshadows')
    expect(u!.searchParams.get('q')).toBe('玉')
  })

  it('畸形 URL（absolute-form 坏主机）→ null（不抛 TypeError）', () => {
    expect(parseRequestUrl(fakeReq('http://[bad') as never)).toBeNull()
  })

  it('url 缺失（undefined）→ 兜底解析 "/"，不抛', () => {
    const u = parseRequestUrl(fakeReq(undefined) as never)
    expect(u).not.toBeNull()
    expect(u!.pathname).toBe('/')
  })
})

// 集成：畸形请求行穿过 server → 400 BAD_INPUT 信封（不再 500/挂死）
let server: http.Server | undefined
let root = ''

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'clwriting-parse-url-'))
  writeFileSync(join(root, 'index.html'), '<!doctype html><title>S</title>')
  server = http.createServer((_req, res) => {
    res.writeHead(200)
    res.end('ok')
  })
  await listenSafe(server!)
})

afterAll(async () => {
  if (server) await new Promise<void>((r) => server!.close(() => r()))
  if (root) rmSync(root, { recursive: true, force: true })
})

describe('R-19: 畸形请求行经真实 HTTP server（llhttp 层确认可达性）', () => {
  it('absolute-form 坏 URL 能到达应用层（llhttp 放行）→ 收编后必被 parseRequestUrl 拦为 null', async () => {
    const address = server!.address() as AddressInfo
    const raw = await new Promise<string>((resolve, reject) => {
      const sock = net.connect(address.port, '127.0.0.1')
      const timer = setTimeout(() => reject(new Error('无响应')), 2_000)
      sock.on('connect', () => {
        sock.write(`GET http://[bad HTTP/1.1\r\nHost: 127.0.0.1:${address.port}\r\n\r\n`)
      })
      sock.on('data', (d) => {
        clearTimeout(timer)
        resolve(d.toString('latin1'))
        sock.destroy()
      })
      sock.on('error', (e) => {
        clearTimeout(timer)
        reject(e)
      })
    })
    expect(raw.startsWith('HTTP/1.1')).toBe(true)
    // llhttp 接受该请求行（应用层可见）——即 Q-1/静态分支与 R-19 各收编点的可达前提
    expect(parseRequestUrl(fakeReq('http://[bad') as never)).toBeNull()
  })
})

// ── 路由模板路径段转义集含 `(` `)`：模板字面段含括号时，`(` `)` 若被当正则分组元字符，
// 字面 URL 匹配不上，且裸捕获组左移 m[i+1] 下标会让 :param 错位取值（埋雷形态）。
// 括号与 `[]{}` 同集按字面匹配后：字面 URL 命中、参数取值正确、去括号 URL 不误命中。
// 手法沿本目录 router-schema.test.ts 既有 createServer+fetch 真分发形态（dispatch 未命中
// 自答 404，防 fetch 悬挂）。──

async function listen(srv: Server): Promise<number> {
  await listenSafe(srv)
  const addr = srv.address()
  return typeof addr === 'object' && addr ? addr.port : 0
}

function getJson(port: number, path: string): Promise<{ status: number; json: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    fetch(`http://127.0.0.1:${port}${path}`)
      .then(async (resp) => resolve({ status: resp.status, json: (await resp.json()) as Record<string, unknown> }))
      .catch(reject)
  })
}

describe('路由模板路径段括号按字面匹配', () => {
  it('模板字面段含 () → 字面 URL 命中、:param 不错位；去括号 URL 不误命中', async () => {
    const routes = createRouteTable()
    withRouteTable(routes, () => {
      route('GET', '/e2/g51/(v1)/echo/:id', (_req, res, params) => {
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ id: params['id'] }))
      })
      // 混排形态：裸捕获组若未被转义会左移 m[i+1]，:a/:b 错位取到括号组
      route('GET', '/e2/g51/(x)/pair/:a/:b', (_req, res, params) => {
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ a: params['a'], b: params['b'] }))
      })
    })
    const srv = createServer((req, res) => {
      void dispatch(req, res, routes).then((hit) => {
        if (!hit) {
          res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify({ code: 'NOT_FOUND' }))
        }
      })
    })
    try {
      const port = await listen(srv)
      // 字面括号 URL 命中，参数取值正确
      const ok = await getJson(port, '/e2/g51/(v1)/echo/42')
      expect(ok.status).toBe(200)
      expect(ok.json).toEqual({ id: '42' })
      // 修复前：/(v1)/ 变捕获组，/e2/g51/v1/echo/42 反而命中（字面 URL 反而不匹配）
      const wrong = await getJson(port, '/e2/g51/v1/echo/42')
      expect(wrong.status).toBe(404)
      // 括号段与 :param 混排：m[i+1] 下标不被裸捕获组挤偏
      const pair = await getJson(port, '/e2/g51/(x)/pair/A/B')
      expect(pair.status).toBe(200)
      expect(pair.json).toEqual({ a: 'A', b: 'B' })
    } finally {
      srv.close()
    }
  })
})

// ── search 端点 URL 解析换轨 parseRequestUrl：search.ts 此前是 api 层唯一残留的裸
// `new URL`（上文收编漏网点）——handler 级畸形 URL 分支依赖 router 前置 parse 兜底，属口径
// 漂移死分叉；换轨后与全库同口径（400 BAD_INPUT）。线上行为回归：正常查询 200 + 结果形状
// 不回退。启动样板收编 bootStudio 空书架形态；get 走裸 http.request 定制形态保留本地
// （不写 books.jsonl 维持「启动扫描自愈登记」原形态）。──

describe('search 端点解析换轨（正常查询行为不回退）', () => {
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
      prefix: 'clw-search-parse-',
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
    const body = JSON.parse(r.text) as {
      results: Array<{ path: string; matches: Array<{ line: number; text: string }> }>
    }
    expect(body.results.length).toBeGreaterThan(0)
    expect(body.results[0]!.matches.length).toBeGreaterThan(0)
  })
})
