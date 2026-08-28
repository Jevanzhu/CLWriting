/**
 * T2-6 · chat / workbench（stream.ts）api 封装行为级护栏。
 *
 * 覆盖：chat 发送/历史（branch 参数编码一次、不过度编码）、工具确认、
 * workbench 状态读与中断。断言 URL/method/body/token 头，非实现细节。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { sendChat, fetchChatHistory, confirmTool, regenerateChat } from '../../../src/studio/web-next/src/api/chat'
import { getState, interrupt, autoWrite, saveDraft } from '../../../src/studio/web-next/src/api/stream'
import { boot } from '../../../src/studio/web-next/src/api/client'

interface Call { url: string; init: RequestInit | undefined }
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

function ok(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
}

beforeEach(async () => {
  stubFetch(() => new Response(JSON.stringify({ token: 'T-cw' }), { status: 200 }))
  await boot()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('chat api', () => {
  it('sendChat：POST {message, chapter} + token 头', async () => {
    stubFetch(() => ok({ ok: true }))
    await sendChat('书A', { message: '写第一章', chapter: 1 })
    const c = calls[0]!
    expect(c.init?.method).toBe('POST')
    expect(c.url).toBe('/api/books/%E4%B9%A6A/chat')
    expect(new Headers(c.init?.headers).get('x-studio-token')).toBe('T-cw')
    expect(JSON.parse(String(c.init?.body))).toEqual({ message: '写第一章', chapter: 1 })
  })

  it('fetchChatHistory：GET 带 limit 尾窗；branch 参数只编码一次（低-1 回归口径）', async () => {
    stubFetch(() => ok({ messages: [] }))
    await fetchChatHistory('书A', 'br 1')
    const url = new URL(calls[0]!.url, 'http://x')
    expect(calls[0]!.init?.method).toBe('GET') // 缺省 GET（client 显式 resolve 为 GET）
    // R72-11（二十轮 F-5）：500→200 对齐 chat store MAX_MESSAGES（多拉的 300 条即弃）
    expect(url.searchParams.get('limit')).toBe('200')
    expect(url.searchParams.get('branch')).toBe('br 1') // 解一层即得原始值 → 未被二次编码
    // 契约①：GET 历史读同样带 token 头
    expect(new Headers(calls[0]!.init?.headers).get('x-studio-token')).toBe('T-cw')
  })

  it('confirmTool：POST {callId, ok}', async () => {
    stubFetch(() => ok({ ok: true }))
    await confirmTool('书A', { callId: 'c1', ok: true })
    expect(calls[0]!.init?.method).toBe('POST')
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({ callId: 'c1', ok: true })
  })

  it('regenerateChat：POST parentSeq/branchId（每次前端新 branchId）', async () => {
    stubFetch(() => ok({ ok: true }))
    await regenerateChat('书A', { parentSeq: 7, branchId: 'br-2' })
    expect(calls[0]!.url).toBe('/api/books/%E4%B9%A6A/chat/regenerate')
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({ parentSeq: 7, branchId: 'br-2' })
  })
})

describe('workbench（stream.ts）api', () => {
  it('getState：GET /state（契约①下带 token 头）', async () => {
    stubFetch(() => ok({ state: 4, stateName: 's4', humanMsg: '', action: '' }))
    const r = await getState('书A')
    expect(r.state).toBe(4)
    expect(calls[0]!.url).toBe('/api/books/%E4%B9%A6A/state')
    expect(new Headers(calls[0]!.init?.headers).get('x-studio-token')).toBe('T-cw')
  })

  it('interrupt：POST /interrupt', async () => {
    stubFetch(() => ok({ ok: true }))
    await interrupt('书A')
    expect(calls[0]!.init?.method).toBe('POST')
    expect(calls[0]!.url).toBe('/api/books/%E4%B9%A6A/interrupt')
  })

  it('autoWrite：POST {chapter}（batchSize=1 不进 body）', async () => {
    stubFetch(() => ok({ ok: true, chapter: 3 }))
    await autoWrite('书A', 3)
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({ chapter: 3 })
    await autoWrite('书A', 3, 5)
    expect(JSON.parse(String(calls[1]!.init?.body))).toEqual({ chapter: 3, batchSize: 5 })
  })

  it('saveDraft：POST {chapter, content} → 透传 docId/snapshotted', async () => {
    stubFetch(() => ok({ ok: true, path: 'p', words: 12, docId: 'd9', snapshotted: true }))
    const r = await saveDraft('书A', 2, '草稿')
    expect(r.docId).toBe('d9')
    expect(r.snapshotted).toBe(true)
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({ chapter: 2, content: '草稿' })
  })
})
