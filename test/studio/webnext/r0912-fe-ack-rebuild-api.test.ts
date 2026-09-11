// @vitest-environment happy-dom
/**
 * R0912-FE 修复批 api 层直测（走真实 client + 桩 fetch，api-endpoints-b 先例）：
 * - acknowledgeJournalPending → POST /api/books/:name/journal/:opId/acknowledge
 *   （R0912-1b 崩溃 pending 人工确认通道的前端封装；URL 编码 + method + 响应解包）
 * - triggerRagRebuild → POST /api/books/:name/rag/rebuild（R0912-FE-P2-12：失配自愈
 *   出口接线，此前前端唯一接线的 build 端点对失配错误文案是指向 rebuild 的断头）
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { acknowledgeJournalPending } from '../../../src/studio/web-next/src/api/stream'
import { triggerRagRebuild, triggerRagBuild } from '../../../src/studio/web-next/src/api/books'
import { boot } from '../../../src/studio/web-next/src/api/client'

interface Call {
  url: string
  init: RequestInit | undefined
}

let calls: Call[] = []
function stubFetch(responder: (c: Call) => Response): void {
  calls = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const c = { url: String(input), init }
      calls.push(c)
      return responder(c)
    }),
  )
}

beforeEach(async () => {
  stubFetch(() => new Response(JSON.stringify({ token: 'T-r0912' }), { status: 200 }))
  await boot()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

function ok(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

describe('acknowledgeJournalPending（R0912-FE-P2-3）', () => {
  it('POST /api/books/:name/journal/:opId/acknowledge，解包 {ok, acknowledged}', async () => {
    stubFetch(() => ok({ ok: true, acknowledged: true }))
    const r = await acknowledgeJournalPending('测试书', 'op-abc-123')
    expect(r).toEqual({ ok: true, acknowledged: true })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe('/api/books/%E6%B5%8B%E8%AF%95%E4%B9%A6/journal/op-abc-123/acknowledge')
    expect(calls[0]!.init?.method).toBe('POST')
  })

  it('opId 走 URL 编码（防路径注入面，服务端按 params 比对不参与路径构造）', async () => {
    stubFetch(() => ok({ ok: true, acknowledged: false }))
    await acknowledgeJournalPending('书', 'op/1?x=1')
    expect(calls[0]!.url).toBe('/api/books/%E4%B9%A6/journal/op%2F1%3Fx%3D1/acknowledge')
  })

  it('幂等第二击 → 服务端 acknowledged:false 原样透传', async () => {
    stubFetch(() => ok({ ok: true, acknowledged: false }))
    const r = await acknowledgeJournalPending('书', 'op-1')
    expect(r.acknowledged).toBe(false)
  })
})

describe('triggerRagRebuild（R0912-FE-P2-12）', () => {
  it('POST /api/books/:name/rag/rebuild，解包 {started, reset}', async () => {
    stubFetch(() => ok({ started: true, reset: true }))
    const r = await triggerRagRebuild('测试书')
    expect(r).toEqual({ started: true, reset: true })
    expect(calls[0]!.url).toBe('/api/books/%E6%B5%8B%E8%AF%95%E4%B9%A6/rag/rebuild')
    expect(calls[0]!.init?.method).toBe('POST')
  })

  it('与 build 端点路径各归各（同任务闸不同语义，前端不得混用）', async () => {
    stubFetch(() => ok({ started: true }))
    await triggerRagBuild('书')
    expect(calls[0]!.url).toContain('/rag/build')
    stubFetch(() => ok({ started: true, reset: true }))
    await triggerRagRebuild('书')
    expect(calls[0]!.url).toContain('/rag/rebuild')
  })
})
