/**
 * R51-G-3（五十一轮）回归：router 路径段转义集含 `(` `)`。
 *
 * 修复前：转义集漏括号——模板字面段含括号时 `(` `)` 被当正则分组元字符：字面 URL
 * 匹配不上，且裸捕获组左移 m[i+1] 下标让 :param 错位取值（埋雷形态）。
 * 修复后：括号与 `[]{}` 同集按字面匹配。手法：本目录 router-schema.test.ts 既有
 * createServer+fetch 真分发形态（dispatch 未命中自答 404，防 fetch 悬挂）。
 */
import { describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { createRouteTable, withRouteTable, route, dispatch } from '../../src/studio/server/router.js'

function listen(srv: Server): Promise<number> {
  return new Promise((resolve) => {
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address()
      resolve(typeof addr === 'object' && addr ? addr.port : 0)
    })
  })
}

function getJson(port: number, path: string): Promise<{ status: number; json: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    fetch(`http://127.0.0.1:${port}${path}`)
      .then(async (resp) => resolve({ status: resp.status, json: (await resp.json()) as Record<string, unknown> }))
      .catch(reject)
  })
}

describe('R51-G-3：路径段括号按字面匹配', () => {
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
