/**
 * 0918二轮修复批（E106）回归：401/403 自动重放收敛幂等面。
 *
 * 原 apiFetch 对一切请求 401→re-boot→token 变化即重放一次——非幂等请求（sendChat
 * 等 POST、删除类 DELETE、无幂等键 PUT）被 re-boot 等待窗后的重发即双发。修复：
 * GET/HEAD 之外不自动重放——re-boot 照常执行（新 token 已就位），401/403 响应原样
 * 透传调用方。
 *
 * R0916-7-P3-26（0916-7 批）：判定口径由「PUT + body 里 JSON.parse 出 operationId」
 * 的嗅探改为**调用方显式声明** init.replayable——本文件相应改两处：
 *   ①「PUT 带 operationId → 重放」改「PUT 显式 replayable: true → 重放」；
 *   ② 新增「PUT body 里带 operationId 但未声明 → 不重放」（钉住嗅探启发式已删，
 *      声明才是唯一入口）。
 *
 * token 为 client 模块级变量：每例 vi.resetModules + 动态 import 取干净实例
 * （同 e2-client-reboot 手法）。
 */
import { describe, it, expect, afterEach, vi } from 'vitest'

function jsonRes(status: number, body: unknown = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

async function freshClient(): Promise<typeof import('../../../src/studio/web-next/src/api/client')> {
  vi.resetModules()
  const c = await import('../../../src/studio/web-next/src/api/client')
  // R64-43：退避注入点换 no-op sleep——boot 若走重试不垫真实墙钟等待
  c.__testHooks.sleep = async () => {}
  return c
}

afterEach(() => {
  vi.unstubAllGlobals()
})

/** fetch 桩工厂：boot 首次发 OLD、re-boot 发 NEW（token 必变，进重放判定分支）；
 *  业务端点按序返回 statuses（每次调用弹出一个） */
function stubBootThen(bizStatuses: number[]): { bizCalls: () => number } {
  let bootCalls = 0
  let biz = 0
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === '/api/boot') {
        bootCalls++
        return jsonRes(200, { token: bootCalls === 1 ? 'OLD' : 'NEW' })
      }
      const status = bizStatuses[Math.min(biz, bizStatuses.length - 1)] ?? 200
      biz++
      return jsonRes(status, status >= 400 ? { code: 'UNAUTHORIZED', error: 'token 无效' } : { ok: true })
    }),
  )
  return { bizCalls: () => biz }
}

describe('E106: 401 重放仅限幂等面', () => {
  it('POST 401 → re-boot 照常但不重放（fetch 恰一次），401 响应透传（修复前：重放双发）', async () => {
    const c = await freshClient()
    const { bizCalls } = stubBootThen([401, 200])
    await c.boot() // 持有 OLD
    const r = await c.apiFetch('/api/books/书A/chat', { method: 'POST', body: '{}' })
    expect(r.status).toBe(401)
    expect(bizCalls()).toBe(1) // 修复点：恰一次（原实现重放一次 = 2）
    expect(c.getToken()).toBe('NEW') // re-boot 仍执行（新 token 已就位供后续请求）
  })

  it('DELETE 401 → 同口径不重放', async () => {
    const c = await freshClient()
    const { bizCalls } = stubBootThen([401, 200])
    await c.boot()
    const r = await c.apiFetch('/api/books/书A/documents/d1', { method: 'DELETE' })
    expect(r.status).toBe(401)
    expect(bizCalls()).toBe(1)
  })

  it('PUT 无声明 401 → 不重放（无幂等键盲发即双写）', async () => {
    const c = await freshClient()
    const { bizCalls } = stubBootThen([401, 200])
    await c.boot()
    const r = await c.apiFetch('/api/books/书A/file?file=x.md', {
      method: 'PUT',
      body: JSON.stringify({ content: 'x' }),
    })
    expect(r.status).toBe(401)
    expect(bizCalls()).toBe(1)
  })

  it('PUT body 带 operationId 但未声明 → 不重放（嗅探启发式已删，声明才是唯一入口）', async () => {
    const c = await freshClient()
    const { bizCalls } = stubBootThen([401, 200])
    await c.boot()
    const r = await c.apiFetch('/api/books/书A/documents/d1/content', {
      method: 'PUT',
      body: JSON.stringify({ content: 'x', expectedRevision: null, operationId: 'op-1', origin: 'manual' }),
    })
    expect(r.status).toBe(401)
    expect(bizCalls()).toBe(1)
  })

  it('PUT 显式声明 replayable → 重放恰一次（文档保存幂等键面）', async () => {
    const c = await freshClient()
    const { bizCalls } = stubBootThen([401, 200])
    await c.boot()
    const r = await c.apiFetch('/api/books/书A/documents/d1/content', {
      method: 'PUT',
      body: JSON.stringify({ content: 'x', expectedRevision: null, operationId: 'op-1', origin: 'manual' }),
      replayable: true,
    })
    expect(r.status).toBe(200) // 重放成功
    expect(bizCalls()).toBe(2) // 重放恰一次
  })

  it('replayable 不落进 fetch init（内部约定不外泄给底层）', async () => {
    const calls: Array<RequestInit | undefined> = []
    let bootCalls = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input) === '/api/boot') {
          bootCalls++
          return jsonRes(200, { token: bootCalls === 1 ? 'OLD' : 'NEW' })
        }
        calls.push(init)
        return jsonRes(200)
      }),
    )
    const c = await freshClient()
    await c.boot()
    await c.apiFetch('/api/books/书A/documents/d1/content', { method: 'PUT', replayable: true, body: '{}' })
    expect(calls).toHaveLength(1)
    expect(calls[0]).not.toHaveProperty('replayable')
  })

  it('POST 401 经 apiJson → 抛 ApiError(401)（信封原样透传，非重放不换统一文案）', async () => {
    const c = await freshClient()
    stubBootThen([401])
    await c.boot()
    await expect(c.apiJson('/api/books/书A/chat', { method: 'POST', json: { message: 'hi' } })).rejects.toMatchObject({
      status: 401,
      code: 'UNAUTHORIZED',
      message: 'token 无效', // 未发生重放——重审-15 的 AUTH_BROKEN 统一文案不触发
    })
  })

  it('对照：GET 401 → 重放一次（既有自愈通道不回归）', async () => {
    const c = await freshClient()
    const { bizCalls } = stubBootThen([401, 200])
    await c.boot()
    const r = await c.apiFetch('/api/books/书A/state')
    expect(r.status).toBe(200)
    expect(bizCalls()).toBe(2)
  })
})
