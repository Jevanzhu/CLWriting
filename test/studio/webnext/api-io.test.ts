/**
 * X-6 · api/io.ts 行为级护栏（导出端点，走真实 client + 桩 fetch）：
 * 覆盖 POST /export 负载口径（format 必带、platform 可选省略）、域形状响应透传、
 * 错误封套映射（非 2xx {code,error} → ApiError 原样透出服务端人话/机器码；
 * 2xx {ok:false,error} → 按域形状原样返回，调用方据 error 展示）。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { exportBook } from '../../../src/studio/web-next/src/api/io'
import { boot, ApiError } from '../../../src/studio/web-next/src/api/client'

let calls: { url: string; init: RequestInit | undefined }[] = []
function stubFetch(responder: () => Response): void {
  calls = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), init })
      return responder()
    }),
  )
}

beforeEach(async () => {
  stubFetch(() => new Response(JSON.stringify({ token: 'T-io' }), { status: 200 }))
  await boot()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

function ok(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
}

describe('io api · 导出', () => {
  it('exportBook：POST 负载 format 必带；platform 缺省不进 body', async () => {
    stubFetch(() => ok({ ok: true, chapterCount: 12, files: ['导出/全书.md'] }))
    await exportBook('书A', { format: 'both' })
    expect(calls[0]!.init?.method).toBe('POST')
    expect(calls[0]!.url).toBe(`/api/books/${encodeURIComponent('书A')}/export`)
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({ format: 'both' })

    await exportBook('书A', { format: 'split', platform: 'wechat' })
    expect(JSON.parse(String(calls[1]!.init?.body))).toEqual({ format: 'split', platform: 'wechat' })
  })

  it('exportBook：域形状响应原样透传（ii 批契约：无 CLI 信封包装）', async () => {
    stubFetch(() => ok({ ok: true, chapterCount: 3, unit: '章', files: ['a.md', 'b.md'] }))
    const r = await exportBook('书A', { format: 'merged' })
    expect(r).toEqual({ ok: true, chapterCount: 3, unit: '章', files: ['a.md', 'b.md'] })
  })

  it('exportBook：2xx {ok:false,error} → 按域形状返回 error（调用方据 error 提示，不抛）', async () => {
    stubFetch(() => ok({ ok: false, error: '无可导出章节' }))
    const r = await exportBook('书A', { format: 'merged' })
    expect(r.ok).toBe(false)
    expect(r.error).toBe('无可导出章节')
  })

  it('exportBook：非 2xx 服务端 {code,error} 信封 → ApiError 透出人话 + 机器码', async () => {
    stubFetch(
      () =>
        new Response(JSON.stringify({ code: 'EXPORT_FAILED', error: '导出失败' }), {
          status: 500,
          headers: { 'content-type': 'application/json' },
        }),
    )
    const err = await exportBook('书A', { format: 'merged' }).then(
      () => { throw new Error('应抛出') },
      (e: unknown) => e,
    )
    expect(err).toBeInstanceOf(ApiError)
    expect((err as ApiError).message).toBe('导出失败')
    expect((err as ApiError).code).toBe('EXPORT_FAILED')
    expect((err as ApiError).status).toBe(500)
  })
})
