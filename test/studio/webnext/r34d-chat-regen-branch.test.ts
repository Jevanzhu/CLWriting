/**
 * R34D-5（三十四轮）回归：regenerate 的历史拉取带 activeBranchId——此前不带
 * branchId 恒拉默认分支：非默认分支 B 上点重新生成时，本地截断/激活作用于 B 分支
 * 视图，POST 的 fork 基点 parentSeq 却取自主线，服务端按主线上下文生成 →「B 分支
 * 前缀 + 主线上文的回答」混合血统视图落库（新 branchId），分支语义被破坏。
 * 修复：fetchChatHistory(bookName, activeBranchId.value ?? undefined)（对齐
 * switchBranch :430 的写法），parentSeq 与截断/激活作用于同一分支。
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

/** 主线历史（默认分支）：最后一条 user 事件 seq=10（线性/默认分支显式 branchId: null） */
const MAIN_HISTORY: { messages: ChatHistoryMessage[]; seqs: number[][]; branchId: string | null } = {
  messages: [
    { role: 'user', content: '主线：写第一章' },
    { role: 'assistant', content: '主线回复' },
  ],
  seqs: [[10], [11]],
  branchId: null,
}

/** 分支 B 历史：最后一条 user 事件 seq=76（与主线分叉——不同的提问上下文） */
const BRANCH_HISTORY: { messages: ChatHistoryMessage[]; seqs: number[][]; branchId: string } = {
  messages: [
    { role: 'user', content: '分支B：换个角度写第一章' },
    { role: 'assistant', content: '分支B回复' },
  ],
  seqs: [[76], [77]],
  branchId: 'b7',
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
  regenMock.mockResolvedValue({ ok: true })
})

describe('R34D-5: regenerate 按当前激活分支取 fork 基点', () => {
  it('非默认分支上重新生成 → 历史拉取带 branchId，parentSeq 取该分支最后一条 user 的 seq（非主线）', async () => {
    const chat = useChatStore()
    // 经 switchBranch 切到非默认分支 b7（activeBranchId 的真实置位路径）
    fetchMock.mockResolvedValueOnce(BRANCH_HISTORY)
    await chat.switchBranch('书A', 'b7')
    expect(chat.activeBranchId).toBe('b7')

    // regenerate 的历史拉取（第二次 fetchChatHistory 调用）
    fetchMock.mockResolvedValueOnce(BRANCH_HISTORY)
    await chat.regenerate('书A')
    await drain()

    // 修复点 1：带 branchId 拉当前显示分支（修复前：fetchChatHistory('书A') 拉主线）
    expect(fetchMock).toHaveBeenLastCalledWith('书A', 'b7')
    // 修复点 2：fork 基点 parentSeq 取分支 B 的最后一条 user seq=76（修复前取主线 10）
    expect(regenMock).toHaveBeenCalledTimes(1)
    const body = regenMock.mock.calls[0]![1] as { parentSeq: number; branchId: string }
    expect(body.parentSeq).toBe(76)
    expect(body.branchId).not.toBe('b7') // 新变体分支 id
  })

  it('本地截断作用于当前分支视图（截断到分支 B 的最后一条 user，非主线消息）', async () => {
    const chat = useChatStore()
    fetchMock.mockResolvedValueOnce(BRANCH_HISTORY)
    await chat.switchBranch('书A', 'b7')
    fetchMock.mockResolvedValueOnce(BRANCH_HISTORY)
    regenMock.mockImplementationOnce(async () => {
      // POST 在途 SSE 抢跑：新回合气泡回流（修复后 parentSeq=76 属分支 B 上下文）
      chat.dispatch({ type: 'chat_start' })
      chat.dispatch({ type: 'chat_turn', turn: 1 })
      chat.dispatch({ type: 'chat_text', text: '分支B的新回复' })
      chat.dispatch({ type: 'chat_done' })
      return { ok: true }
    })
    await chat.regenerate('书A')
    await drain()

    // 视图 = 分支 B 的 user 前缀 + 新回复（不再混入主线消息）
    expect(chat.messages.map((m) => m.role)).toEqual(['user', 'assistant'])
    expect(chat.messages[0]!.content).toBe('分支B：换个角度写第一章')
    expect(chat.messages[chat.messages.length - 1]!.content).toBe('分支B的新回复')
    expect(chat.activeBranchId).not.toBe('b7') // 激活到新变体分支
  })

  it('默认分支（activeBranchId=null）→ 拉取不带 branchId（向后兼容回归）', async () => {
    const chat = useChatStore()
    // 种子化主线历史（activeBranchId 置为 history 返回的 '' → store 归 null）
    fetchMock.mockResolvedValueOnce(MAIN_HISTORY)
    await chat.seedHistory('书A')
    expect(chat.activeBranchId).toBeNull()

    fetchMock.mockResolvedValueOnce(MAIN_HISTORY)
    await chat.regenerate('书A')
    await drain()
    expect(fetchMock).toHaveBeenLastCalledWith('书A', undefined)
    const body = regenMock.mock.calls[0]![1] as { parentSeq: number }
    expect(body.parentSeq).toBe(10) // 主线口径不变
  })
})
