/**
 * 四轮重评 P3-16（2026-09-15 处置批）：fetchChatHistory 的 messages 运行时归一。
 * 类型上 messages 必选，但 2xx 坏体（字段缺省形态）可达 undefined——chat store 两处
 * 消费（seedHistory 判空 / regenerate 反向扫描）是族内唯一裸取点，undefined 会长成
 * unhandled rejection。修法：api 层返回处单源 `?? []`，返回类型「非空」名实相符。
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import { fetchChatHistory } from '../../../src/studio/web-next/src/api/chat'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('四轮重评 P3-16: fetchChatHistory messages 归一', () => {
  it('2xx 坏体缺 messages 字段 → 归一为 []（非 undefined，裸取消费方安全）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({}), { status: 200 })))
    const r = await fetchChatHistory('书A')
    expect(r.messages).toEqual([])
  })

  it('正常载荷透传不变：messages 原样 + 其余字段（seqs/branchId/truncated/total）原样', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              messages: [{ role: 'user', content: 'hi' }],
              seqs: [[7]],
              branchId: null,
              truncated: true,
              total: 9,
            }),
            { status: 200 },
          ),
      ),
    )
    const r = await fetchChatHistory('书A')
    expect(r.messages).toEqual([{ role: 'user', content: 'hi' }])
    expect(r.seqs).toEqual([[7]])
    expect(r.branchId).toBeNull()
    expect(r.truncated).toBe(true)
    expect(r.total).toBe(9)
  })
})
