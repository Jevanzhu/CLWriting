/**
 * X-6 · api/stream.ts 行为级护栏（工作台 HTTP 端点，走真实 client + 桩 fetch）：
 * 覆盖读态机 / 自动写章（batchSize 负载形态）/ 存稿 / 取注入源清单的 URL、method、
 * body 口径与响应解包。AI 阻塞端点（spawn/outline）的超时行为属 client.ts apiJson
 * 职责（api-client.test.ts 已覆盖），此处只断言请求负载。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { getState, autoWrite, saveDraft, getDraftPrompt, interrupt } from '../../../src/studio/web-next/src/api/stream'
import { boot } from '../../../src/studio/web-next/src/api/client'

interface Call { url: string; init: RequestInit | undefined }

let calls: Call[] = []
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
  // 先 boot 拿 token（模块级，文件内后续请求都带 T-stream）
  stubFetch(() => new Response(JSON.stringify({ token: 'T-stream' }), { status: 200 }))
  await boot()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

function ok(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
}

describe('stream api · 工作台端点', () => {
  it('getState：GET /state → 态机状态解包', async () => {
    stubFetch(() => ok({ state: 2, stateName: '写稿', humanMsg: '可续写', action: 'next', nextChapter: 5 }))
    const r = await getState('书A')
    expect(calls[0]!.init?.method).toBe('GET')
    expect(calls[0]!.url).toBe(`/api/books/${encodeURIComponent('书A')}/state`)
    expect(r.stateName).toBe('写稿')
    expect(r.nextChapter).toBe(5)
  })

  it('autoWrite：POST body 带 chapter；batchSize>1 才进 body（=1 缺省不传）', async () => {
    stubFetch(() => ok({ ok: true, chapter: 3, batchSize: 1 }))
    await autoWrite('书A', 3)
    expect(calls[0]!.init?.method).toBe('POST')
    expect(calls[0]!.url).toBe(`/api/books/${encodeURIComponent('书A')}/auto-write`)
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({ chapter: 3 })

    await autoWrite('书A', 4, 3)
    expect(JSON.parse(String(calls[1]!.init?.body))).toEqual({ chapter: 4, batchSize: 3 })
  })

  it('saveDraft：POST {chapter, content} → {ok, path, words, docId, snapshotted}', async () => {
    stubFetch(() => ok({ ok: true, path: '写作/正文/第3章.md', words: 2100, docId: 'd3', snapshotted: true }))
    const r = await saveDraft('书A', 3, '正文内容')
    expect(calls[0]!.url).toBe(`/api/books/${encodeURIComponent('书A')}/draft-save`)
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({ chapter: 3, content: '正文内容' })
    expect(r.docId).toBe('d3')
    expect(r.snapshotted).toBe(true)
  })

  it('getDraftPrompt：GET /draft-prompt?chapter= → {prompt, files}', async () => {
    stubFetch(() => ok({ prompt: '提示词', files: ['设定/角色.md'] }))
    const r = await getDraftPrompt('书A', 7)
    expect(calls[0]!.init?.method).toBe('GET')
    expect(calls[0]!.url).toBe(`/api/books/${encodeURIComponent('书A')}/draft-prompt?chapter=7`)
    expect(r.files).toEqual(['设定/角色.md'])
  })

  it('interrupt：POST 无 body（中断当前生成）', async () => {
    stubFetch(() => ok({}))
    await interrupt('书A')
    expect(calls[0]!.init?.method).toBe('POST')
    expect(calls[0]!.url).toBe(`/api/books/${encodeURIComponent('书A')}/interrupt`)
    expect(calls[0]!.init?.body).toBeUndefined()
  })
})
