/**
 * 低-1（第十轮）：fetchChatHistory 的 branchId 编码回归。
 *
 * 旧实现手编 encodeURIComponent 后又进 URLSearchParams.toString()，特殊字符被
 * 二次编码（'br 1' → 'br%201' → 'br%25201'），服务端解一层拿到残缺 'br%201'，
 * 分支查询静默落空。修法：去掉手编，交给 params.toString() 统一编码（只编一次）。
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import { fetchChatHistory } from '../../../src/studio/web-next/src/api/chat'

afterEach(() => {
  vi.unstubAllGlobals()
})

/** 取 fetch mock 收到的最近一次请求 URL（apiJson → apiFetch → fetch(path, init)） */
function lastUrl(): string {
  const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>
  const calls = fetchMock.mock.calls
  return String(calls[calls.length - 1]?.[0])
}

describe('低-1（第十轮）：fetchChatHistory branchId 只编码一次', () => {
  it('字母数字与 -/_（br-1_9）→ 原样入 URL，无 %25 双重编码残迹', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ messages: [] }))))
    await fetchChatHistory('书A', 'br-1_9')
    expect(lastUrl()).toContain('branch=br-1_9')
    // 双重编码的指纹是 % 被再编成 %25（旧实现对任何需编码字符都会产生）
    expect(lastUrl()).not.toContain('%2520')
    expect(lastUrl()).not.toContain('%252D')
  })

  it('含空格的分支号 → 只编码一次（branch=br-1_9+1），不再是 br%25201', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ messages: [] }))))
    await fetchChatHistory('书A', 'br-1_9 1')
    // URLSearchParams 单次序列化：空格 → '+'；旧实现双编后此处是 br-1_9%25201
    expect(lastUrl()).toContain('branch=br-1_9+1')
    expect(lastUrl()).not.toContain('%25201')
  })
})
