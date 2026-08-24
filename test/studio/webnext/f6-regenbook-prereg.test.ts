/**
 * F6（五十九轮）回归：regenerate 的 regenBook 前置到 POST 之前——修复前「POST 成功
 * 返回后才赋值」的窗口内 SSE 可抢跑（服务端收到请求即开跑并回流 chat_done），届时
 * 读 null 漏刷分支列表。POST 失败由 finally 清，不污染后续回合。
 */
import { describe, expect, it, beforeEach, vi } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'

vi.mock('../../../src/studio/web-next/src/api/chat', () => ({
  sendChat: vi.fn(),
  clearChatHistory: vi.fn(),
  confirmTool: vi.fn(),
  fetchChatHistory: vi.fn(),
  fetchChatBranches: vi.fn(),
  regenerateChat: vi.fn(),
}))

import { fetchChatHistory, fetchChatBranches, regenerateChat, type ChatHistoryMessage } from '../../../src/studio/web-next/src/api/chat'
import { useChatStore } from '../../../src/studio/web-next/src/stores/chat'

const fetchMock = fetchChatHistory as ReturnType<typeof vi.fn>
const branchesMock = fetchChatBranches as ReturnType<typeof vi.fn>
const regenMock = regenerateChat as ReturnType<typeof vi.fn>

const SEQ_HISTORY: { messages: ChatHistoryMessage[]; seqs: number[][]; branchId: string } = {
  messages: [
    { role: 'user', content: '写第二章' },
    { role: 'assistant', content: '好的，马上写。' },
  ],
  seqs: [[10], [11]],
  branchId: 'b1',
}

function seedLocalTurn(chat: ReturnType<typeof useChatStore>): void {
  chat.pushUser('写第二章')
  chat.dispatch({ type: 'chat_start' })
  chat.dispatch({ type: 'chat_turn', turn: 0 })
  chat.dispatch({ type: 'chat_text', text: '好的，马上写。' })
  chat.dispatch({ type: 'chat_done' })
}

/** 泵微任务（refreshBranches 是 fire-and-forget async，需等其内部 await 走完） */
async function drain(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve()
  await new Promise((r) => setTimeout(r, 0))
}

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  branchesMock.mockResolvedValue({ branches: [], activeBranchId: null })
})

describe('F6: regenBook 前置——POST 在途 SSE 抢跑 chat_done 不漏刷分支', () => {
  it('POST resolve 前 SSE 已回流完整回合（chat_done）→ 分支列表照常刷新', async () => {
    const chat = useChatStore()
    seedLocalTurn(chat)
    fetchMock.mockResolvedValueOnce(SEQ_HISTORY)
    // 服务端收到 POST 即开跑：SSE 事件在 POST promise resolve 之前全部回流（抢跑窗口）
    regenMock.mockImplementationOnce(async () => {
      chat.dispatch({ type: 'chat_start' })
      chat.dispatch({ type: 'chat_turn', turn: 1 })
      chat.dispatch({ type: 'chat_text', text: '新版回复' })
      chat.dispatch({ type: 'chat_done' })
      return { ok: true }
    })

    await chat.regenerate('书A')
    await drain()

    // 修复点：chat_done 消费到前置登记的 regenBook → best-effort 刷分支
    expect(branchesMock).toHaveBeenCalledWith('书A')
    expect(chat.messages[chat.messages.length - 1]!.content).toBe('新版回复')
  })

  it('POST 失败 → 前置登记被 finally 清（后续无关 chat_done 不误刷分支）', async () => {
    const chat = useChatStore()
    seedLocalTurn(chat)
    fetchMock.mockResolvedValueOnce(SEQ_HISTORY)
    regenMock.mockRejectedValueOnce(new Error('服务开小差'))

    await chat.regenerate('书A')
    expect(chat.error).toBe('服务开小差')
    // 后续无关回合收尾：不得消费到残留书名去刷分支
    chat.pushUser('再问一次')
    chat.dispatch({ type: 'chat_start' })
    chat.dispatch({ type: 'chat_turn', turn: 0 })
    chat.dispatch({ type: 'chat_text', text: '回复' })
    chat.dispatch({ type: 'chat_done' })
    await drain()
    expect(branchesMock).not.toHaveBeenCalled()
  })
})
