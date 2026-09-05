/**
 * 重评-7（全库代码重评审 2026-09-05）回归：请求体读取中客户端断连不再当服务端错误。
 *
 * 修复背景：readJson 的 req 'error' 此前原样 reject——客户端中途断连（ECONNRESET/
 * EPIPE）落进 dispatch 兜底 catch 后按原始错误 log.error + 500，正常断连被当服务端
 * 故障留日志噪音。修复：readJson 给断连错误打 clientAbort 标记（http.ts，不换壳保
 * 留 errno）；dispatch 兜底对带标记错误降 log.info（回包路径不变，写给已断 socket
 * 无实害）；其余错误路径零变更。
 *
 * 注入方式：mock log 模块观测日志级别；PassThrough 假 req（复用 readjson-chunked
 * 手法）+ 桩 res 直调 readJson / dispatch——断连时序全同步可控，无真实 socket 抖动。
 */
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../src/log/index.js', () => ({
  log: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}))

import { log } from '../../src/log/index.js'
import { readJson, reply } from '../../src/studio/server/http.js'
import { createRouteTable, dispatch, route, withRouteTable } from '../../src/studio/server/router.js'

/** 假 req：PassThrough 底座（复用 readjson-chunked 手法）+ method/url（dispatch 匹配面） */
type FakeReq = PassThrough & IncomingMessage
function fakeReq(method: string, url: string): FakeReq {
  const req = new PassThrough() as FakeReq
  ;(req as unknown as { method: string; url: string }).method = method
  ;(req as unknown as { url: string }).url = url
  return req
}

/** 桩 res：headersSent 可变 + writeHead/end 桩——回包断言面 */
type StubRes = ServerResponse & {
  headersSent: boolean
  writeHead: ReturnType<typeof vi.fn>
  end: ReturnType<typeof vi.fn>
}
function fakeRes(): StubRes {
  const res = new EventEmitter() as unknown as StubRes
  res.headersSent = false
  res.writeHead = vi.fn()
  res.end = vi.fn()
  return res
}

/** 注册一条「读 body 后回 200」的探针路由（错误即从 handler 抛进 dispatch 兜底） */
function registerEchoRoute(): ReturnType<typeof createRouteTable> {
  const routes = createRouteTable()
  withRouteTable(routes, () => {
    route('POST', '/api/echo', async (req, res) => {
      await readJson(req)
      reply(res, 200, { ok: true })
    })
  })
  return routes
}

describe('重评-7: readJson 断连标记（http.ts）', () => {
  it('req 中途 ECONNRESET → reject 原始错误且带 clientAbort 标记（不换壳，errno 保留）', async () => {
    const req = fakeReq('POST', '/api/echo')
    const pending = readJson(req)
    req.emit('error', Object.assign(new Error('aborted'), { code: 'ECONNRESET' }))
    await expect(pending).rejects.toMatchObject({ code: 'ECONNRESET', clientAbort: true })
  })

  it('req 中途 EPIPE 同口径打标记', async () => {
    const req = fakeReq('POST', '/api/echo')
    const pending = readJson(req)
    req.emit('error', Object.assign(new Error('write after end'), { code: 'EPIPE' }))
    await expect(pending).rejects.toMatchObject({ code: 'EPIPE', clientAbort: true })
  })

  it('其他读错误（EACCES）不打标记（原样透传，零变更）', async () => {
    const req = fakeReq('POST', '/api/echo')
    const pending = readJson(req)
    req.emit('error', Object.assign(new Error('permission denied'), { code: 'EACCES' }))
    const err = (await pending.catch((e: unknown) => e)) as { code?: string; clientAbort?: boolean }
    expect(err.code).toBe('EACCES')
    expect(err.clientAbort).toBeUndefined()
  })
})

describe('重评-7: dispatch 兜底日志分级（router.ts）', () => {
  beforeEach(() => {
    vi.mocked(log.error).mockClear()
    vi.mocked(log.warn).mockClear()
    vi.mocked(log.info).mockClear()
  })

  it('请求体读取中客户端断连 → 不产生 error 级日志，降 info 留痕；仍尝试 500 兜底回包', async () => {
    const routes = registerEchoRoute()
    const req = fakeReq('POST', '/api/echo')
    const res = fakeRes()
    const done = dispatch(req, res, routes)
    // 断连：请求体未收完即 error（真实链路为客户端掐断 socket 的 ECONNRESET）
    req.emit('error', Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }))
    expect(await done).toBe(true)

    // 修复前：断连被当服务端错误 log.error + 500 留日志噪音
    expect(vi.mocked(log.error)).not.toHaveBeenCalled()
    expect(vi.mocked(log.info)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(log.info).mock.calls[0]?.[0]).toBe('api')
    expect(String(vi.mocked(log.info).mock.calls[0]?.[1])).toContain('client abort')
    // 回包路径不变：写给已断 socket 无实害（500 'ERROR' 信封照旧尝试）
    expect(vi.mocked(res.writeHead)).toHaveBeenCalledWith(500, expect.anything())
    expect(vi.mocked(res.end)).toHaveBeenCalledTimes(1)
  })

  it('对照：非法 JSON（非断连错误）→ 照旧 error 级日志 + 400 BAD_INPUT 信封（零变更）', async () => {
    const routes = registerEchoRoute()
    const req = fakeReq('POST', '/api/echo')
    const res = fakeRes()
    const done = dispatch(req, res, routes)
    req.write(Buffer.from('{bad json'))
    req.end()
    expect(await done).toBe(true)

    expect(vi.mocked(log.error)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(log.info)).not.toHaveBeenCalled()
    expect(vi.mocked(res.writeHead)).toHaveBeenCalledWith(400, expect.anything())
    const body = JSON.parse(String(vi.mocked(res.end).mock.calls[0]?.[0])) as { code: string }
    expect(body.code).toBe('BAD_INPUT')
  })
})
