/**
 * E2（CS-14 按 HTTP 形态等价物）测试：route schema 单点声明（defineRoute）。
 * 验收：1) defineRoute 注册 + parse 校验（400 {error} 信封）；2) 重复声明拒绝；
 *       3) Map 注册表防原型链注入（__proto__/constructor 不命中）；4) dispatch path 参数 null-proto 防注入。
 */
import { describe, expect, it, vi } from 'vitest'
import { createServer, type Server } from 'node:http'
import { defineRoute, getRouteSchema } from '../../src/studio/server/api/schema.js'
import { dispatch, route } from '../../src/studio/server/router.js'

function listen(srv: Server): Promise<number> {
  return new Promise((resolve) => {
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address()
      resolve(typeof addr === 'object' && addr ? addr.port : 0)
    })
  })
}

function postJson(port: number, path: string, body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const req = fetch(`http://127.0.0.1:${port}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    req.then(async (resp) => {
      const json = (await resp.json()) as Record<string, unknown>
      resolve({ status: resp.status, json })
    }).catch(reject)
  })
}

describe('E2: route schema 单点声明', () => {
  it('defineRoute：parse 校验失败 → 400 {error} 信封；合法 → handler 收类型化 input', async () => {
    defineRoute('e2.echo', {
      method: 'POST',
      path: '/e2/:name/echo',
      parse: (raw) => {
        const body = (raw ?? {}) as Record<string, unknown>
        const n = Number(body['n'])
        if (!Number.isFinite(n) || n < 0) throw new Error('n 需为非负数字')
        return { n }
      },
      handler: async ({ params, input }, _req, res) => {
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ name: params['name'], n: input.n }))
      },
    })
    const srv = createServer((req, res) => { void dispatch(req, res) })
    const port = await listen(srv)
    // 合法请求
    const ok = await postJson(port, '/e2/book-a/echo', { n: 3 })
    expect(ok.status).toBe(200)
    expect(ok.json).toEqual({ name: 'book-a', n: 3 })
    // 校验失败 → 400 {error} 信封
    const bad = await postJson(port, '/e2/book-a/echo', { n: -1 })
    expect(bad.status).toBe(400)
    expect(bad.json['error']).toBe('n 需为非负数字')
    srv.close()
  })

  it('defineRoute：重复声明拒绝；getRouteSchema 查注册表', () => {
    expect(() =>
      defineRoute('e2.echo', {
        method: 'POST', path: '/e2/x', handler: async () => {},
      }),
    ).toThrow('route 重复声明')
    const schema = getRouteSchema('e2.echo')
    expect(schema).not.toBeNull()
    expect(schema!.path).toBe('/e2/:name/echo')
    expect(getRouteSchema('e2.__proto__')).toBeNull()
    expect(getRouteSchema('constructor')).toBeNull()
  })

  it('dispatch path 参数 null-proto：__proto__ 键不触发原型链', async () => {
    // 直接构造含 __proto__ 的 path 参数请求——路由表匹配不到该 path（正常业务路由无此模板），
    // 重点验证 params 组装对象为 null-prototype，__proto__ 赋值不污染 Object.prototype
    const srv = createServer((req, res) => { void dispatch(req, res) })
    const port = await listen(srv)
    const resp = await fetch(`http://127.0.0.1:${port}/e2/__proto__/echo`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ n: 1 }),
    })
    expect(resp.status).toBe(200)
    expect((await resp.json()) as Record<string, unknown>).toEqual({ name: '__proto__', n: 1 })
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined()
    srv.close()
  })

  it('AA-P3-10: 路径参数损坏 % 编码 → 400 统一信封（不再 500）', async () => {
    // decodeURIComponent('%E4%') 抛 URIError——此前 decode 在 handler try 外，
    // URIError 逃出 dispatch → 外层 catch → 500；现 decode 入 try，解析失败归 400。
    const srv = createServer((req, res) => { void dispatch(req, res) })
    const port = await listen(srv)
    const resp = await fetch(`http://127.0.0.1:${port}/e2/%E4%/echo`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ n: 1 }),
    })
    expect(resp.status).toBe(400)
    // hh §八-12：错误信封统一 {code, error}
    expect(await resp.json()).toEqual({ code: 'BAD_PATH', error: '路径参数编码无效' })
    srv.close()
  })

  it('Z-P2-9：handler 抛非 HttpError → 500 {error} 信封 + console.error 留诊断日志', async () => {
    // 异常被 dispatch 内部 catch 兜底（外层 index.ts 的 try 接不到），
    // 若无日志则 500「内部错误」无从排障——验证日志已打且含 method/url/原始异常
    route('GET', '/e2/boom', () => {
      throw new Error('boom: api_key=sk-secret1234567890')
    })
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const srv = createServer((req, res) => { void dispatch(req, res) })
      const port = await listen(srv)
      const resp = await fetch(`http://127.0.0.1:${port}/e2/boom`)
      // 客户端只见 500 信封（敏感 detail 不外泄）；hh §八-12 统一 {code, error}
      expect(resp.status).toBe(500)
      expect(await resp.json()).toEqual({ code: 'ERROR', error: '内部错误' })
      // server 侧日志：前缀 + method + url + 原始异常
      expect(errSpy).toHaveBeenCalledTimes(1)
      const [prefix, method, url, err] = errSpy.mock.calls[0]!
      expect(prefix).toBe('[api] handler error:')
      expect(method).toBe('GET')
      expect(url).toBe('/e2/boom')
      expect(err).toBeInstanceOf(Error)
      expect((err as Error).message).toContain('boom')
      srv.close()
    } finally {
      errSpy.mockRestore()
    }
  })
})

