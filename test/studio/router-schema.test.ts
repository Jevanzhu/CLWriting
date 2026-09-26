/**
 * E2（CS-14 按 HTTP 形态等价物）测试：route schema 单点声明（defineRoute）。
 * 验收：1) defineRoute 注册 + parse 校验（400 {error} 信封）；2) 重复声明拒绝；
 *       3) Map 注册表防原型链注入（__proto__/constructor 不命中）；4) dispatch path 参数 null-proto 防注入。
 */
import { describe, expect, it, vi } from 'vitest'
import { createServer, type Server } from 'node:http'
import { defineRoute, getRouteSchema, resetRouteSchemas } from '../../src/studio/server/api/schema.js'
import { createRouteTable, dispatch, route, withRouteTable } from '../../src/studio/server/router.js'
import { HttpError, replyError } from '../../src/studio/server/http.js'
import { listenSafe } from '../helpers/safe-port.js'

async function listen(srv: Server): Promise<number> {
  await listenSafe(srv)
  const addr = srv.address()
  return typeof addr === 'object' && addr ? addr.port : 0
}

function postJson(
  port: number,
  path: string,
  body: unknown,
): Promise<{ status: number; json: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const req = fetch(`http://127.0.0.1:${port}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    req
      .then(async (resp) => {
        const json = (await resp.json()) as Record<string, unknown>
        resolve({ status: resp.status, json })
      })
      .catch(reject)
  })
}

describe('E2: route schema 单点声明', () => {
  it('defineRoute：parse 校验失败 → 400 {error} 信封；合法 → handler 收类型化 input', async () => {
    let handlerCalls = 0 // M-5：parse 失败后 handler 不得被调用（旧实现缺 return 继续进 handler）
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
        handlerCalls += 1
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ name: params['name'], n: input.n }))
      },
    })
    const srv = createServer((req, res) => {
      void dispatch(req, res)
    })
    const port = await listen(srv)
    // 合法请求
    const ok = await postJson(port, '/e2/book-a/echo', { n: 3 })
    expect(ok.status).toBe(200)
    expect(ok.json).toEqual({ name: 'book-a', n: 3 })
    expect(handlerCalls).toBe(1)
    // 校验失败 → 400 {code, error} 信封（ii-3：defineRoute parse 失败也走统一双字段信封）
    const bad = await postJson(port, '/e2/book-a/echo', { n: -1 })
    expect(bad.status).toBe(400)
    expect(bad.json).toEqual({ code: 'BAD_INPUT', error: 'n 需为非负数字' })
    // M-5：回复 400 后 handler 不进（input 停留 undefined，旧实现二次 write + 空跑）
    expect(handlerCalls).toBe(1)
    srv.close()
  })

  it('defineRoute：重复声明拒绝；getRouteSchema 查注册表', () => {
    expect(() =>
      defineRoute('e2.echo', {
        method: 'POST',
        path: '/e2/x',
        handler: async () => {},
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
    const srv = createServer((req, res) => {
      void dispatch(req, res)
    })
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

  it('重评2-P3-③：注册表按路由表隔离——第二实例 reset/注册不清空第一实例视图', () => {
    // 模拟同进程双 startServer：各自 createRouteTable + withRouteTable 建路由
    // （buildRoutes 形态：reset 在 withRouteTable 外、注册在表内——index.ts 口径）
    const t1 = createRouteTable()
    const t2 = createRouteTable()
    withRouteTable(t1, () => defineRoute('re2.inst1', { method: 'GET', path: '/re2/inst1', handler: async () => {} }))
    withRouteTable(t2, () => {
      resetRouteSchemas() // 第二实例建表前的既有 reset 调用（修前会清空第一实例注册视图）
      defineRoute('re2.inst2', { method: 'GET', path: '/re2/inst2', handler: async () => {} })
    })
    // 第一实例：自己的 schema 仍可查、第二实例的不可见、同表重复声明仍拒绝
    withRouteTable(t1, () => {
      expect(getRouteSchema('re2.inst1')).not.toBeNull()
      expect(getRouteSchema('re2.inst2')).toBeNull()
      expect(() => defineRoute('re2.inst1', { method: 'GET', path: '/re2/dup', handler: async () => {} })).toThrow(
        'route 重复声明',
      )
    })
    // 第二实例：对称成立
    withRouteTable(t2, () => {
      expect(getRouteSchema('re2.inst2')).not.toBeNull()
      expect(getRouteSchema('re2.inst1')).toBeNull()
    })
  })

  it('AA-P3-10: 路径参数损坏 % 编码 → 400 统一信封（不再 500）', async () => {
    // decodeURIComponent('%E4%') 抛 URIError——此前 decode 在 handler try 外，
    // URIError 逃出 dispatch → 外层 catch → 500；现 decode 入 try，解析失败归 400。
    const srv = createServer((req, res) => {
      void dispatch(req, res)
    })
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

  it('Z-P2-9：handler 抛非 HttpError → 500 {error} 信封 + 日志留诊断（A4 批 0 起 log 模块承载）', async () => {
    // 异常被 dispatch 内部 catch 兜底（外层 index.ts 的 try 接不到），
    // 若无日志则 500「内部错误」无从排障——验证日志已打且含 method/url/原始异常。
    // A4 批 0：console.error → log.error('api', msg, err)，未 init 落盘时镜像
    // console.error（单参 msg + err），tag 语义不变
    route('GET', '/e2/boom', () => {
      throw new Error('boom: api_key=sk-secret1234567890')
    })
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const srv = createServer((req, res) => {
        void dispatch(req, res)
      })
      const port = await listen(srv)
      const resp = await fetch(`http://127.0.0.1:${port}/e2/boom`)
      // 客户端只见 500 信封（敏感 detail 不外泄）；hh §八-12 统一 {code, error}
      expect(resp.status).toBe(500)
      expect(await resp.json()).toEqual({ code: 'ERROR', error: '内部错误' })
      // server 侧日志镜像：tag 前缀 + method/url + 原始异常
      expect(errSpy).toHaveBeenCalledTimes(1)
      const [msg, err] = errSpy.mock.calls[0]!
      expect(msg).toBe('[api] handler error: GET /e2/boom')
      expect(err).toBeInstanceOf(Error)
      expect((err as Error).message).toContain('boom')
      srv.close()
    } finally {
      errSpy.mockRestore()
    }
  })

  // R0916-7-P3-13：parse 前置闸（RouteSchema.gate）钩子语义——执行序、中止、
  // 收尾 cleanup、抛错口径四件。端点级验证（/spawn、/auto-write 仍是忙闸先于
  // body 400）见 api-input-validation.test.ts。
  it('gate → parse → handler 执行序；闸产出经 ctx.gate 透传 handler', async () => {
    const calls: string[] = []
    defineRoute('e2.gate.order', {
      method: 'POST',
      path: '/e2/gate/order',
      gate: () => {
        calls.push('gate')
        return { value: { tag: 'g' } }
      },
      parse: (raw) => {
        calls.push('parse')
        return { n: Number((raw as { n?: unknown }).n) }
      },
      handler: async ({ input, gate }, _req, res) => {
        calls.push('handler')
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ n: input.n, tag: gate.tag }))
      },
    })
    const srv = createServer((req, res) => {
      void dispatch(req, res)
    })
    const port = await listen(srv)
    const ok = await postJson(port, '/e2/gate/order', { n: 7 })
    expect(ok.status).toBe(200)
    expect(ok.json).toEqual({ n: 7, tag: 'g' })
    expect(calls).toEqual(['gate', 'parse', 'handler'])
    srv.close()
  })

  it('gate 返回 false（闸内已回错误）→ parse/handler 都不进，且不追加第二条信封', async () => {
    const calls: string[] = []
    defineRoute('e2.gate.block', {
      method: 'POST',
      path: '/e2/gate/block',
      gate: ({ res }) => {
        calls.push('gate')
        replyError(res, 409, 'BUSY', '闸拦下了')
        return false
      },
      parse: () => {
        calls.push('parse')
        throw new Error('不该到这里')
      },
      handler: async () => {
        calls.push('handler')
      },
    })
    const srv = createServer((req, res) => {
      void dispatch(req, res)
    })
    const port = await listen(srv)
    const busy = await postJson(port, '/e2/gate/block', { n: -1 }) // 体也非法：闸先拦则只见 409
    expect(busy.status).toBe(409)
    expect(busy.json).toEqual({ code: 'BUSY', error: '闸拦下了' })
    expect(calls).toEqual(['gate'])
    srv.close()
  })

  it('parse 失败 → 400 且 handler 未被调用；闸 cleanup 在收尾执行一次（占位不泄漏）', async () => {
    let handlerCalls = 0
    const cleanups: string[] = []
    defineRoute('e2.gate.cleanup-parse', {
      method: 'POST',
      path: '/e2/gate/cleanup-parse',
      gate: () => ({
        value: { tag: 'g' },
        cleanup: () => {
          cleanups.push('release')
        },
      }),
      parse: () => {
        throw new Error('体不合法')
      },
      handler: async () => {
        handlerCalls += 1
      },
    })
    const srv = createServer((req, res) => {
      void dispatch(req, res)
    })
    const port = await listen(srv)
    const bad = await postJson(port, '/e2/gate/cleanup-parse', {})
    expect(bad.status).toBe(400)
    expect(bad.json).toEqual({ code: 'BAD_INPUT', error: '体不合法' })
    expect(handlerCalls).toBe(0)
    expect(cleanups).toEqual(['release'])
    srv.close()
  })

  it('handler 正常返回与抛错两路 cleanup 各执行一次（抛错仍由 dispatch 兜 500）', async () => {
    const cleanups: string[] = []
    defineRoute('e2.gate.cleanup-ok', {
      method: 'POST',
      path: '/e2/gate/cleanup-ok',
      gate: () => ({
        value: { tag: 'g' },
        cleanup: () => {
          cleanups.push('ok')
        },
      }),
      handler: async (_ctx, _req, res) => {
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ ok: true }))
      },
    })
    defineRoute('e2.gate.cleanup-throw', {
      method: 'POST',
      path: '/e2/gate/cleanup-throw',
      gate: () => ({
        value: { tag: 'g' },
        cleanup: () => {
          cleanups.push('throw')
        },
      }),
      handler: async () => {
        throw new Error('handler 爆炸')
      },
    })
    const srv = createServer((req, res) => {
      void dispatch(req, res)
    })
    const port = await listen(srv)
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      expect((await postJson(port, '/e2/gate/cleanup-ok', {})).status).toBe(200)
      expect((await postJson(port, '/e2/gate/cleanup-throw', {})).status).toBe(500)
    } finally {
      errSpy.mockRestore()
    }
    expect(cleanups).toEqual(['ok', 'throw'])
    srv.close()
  })

  it('闸抛错同 parse 口径：普通 Error → 400 BAD_INPUT；HttpError → 透传自身状态码与码', async () => {
    defineRoute('e2.gate.thrown', {
      method: 'POST',
      path: '/e2/gate/thrown',
      gate: () => {
        throw new Error('闸内普通错')
      },
      handler: async () => {},
    })
    defineRoute('e2.gate.http-error', {
      method: 'POST',
      path: '/e2/gate/http-error',
      gate: () => {
        throw new HttpError(413, '请求体过大', 'PAYLOAD_TOO_LARGE')
      },
      handler: async () => {},
    })
    const srv = createServer((req, res) => {
      void dispatch(req, res)
    })
    const port = await listen(srv)
    const plain = await postJson(port, '/e2/gate/thrown', {})
    expect(plain.status).toBe(400)
    expect(plain.json).toEqual({ code: 'BAD_INPUT', error: '闸内普通错' })
    const httpErr = await postJson(port, '/e2/gate/http-error', {})
    expect(httpErr.status).toBe(413)
    expect(httpErr.json).toEqual({ code: 'PAYLOAD_TOO_LARGE', error: '请求体过大' })
    srv.close()
  })
})
