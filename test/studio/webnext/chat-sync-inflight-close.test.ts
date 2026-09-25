/**
 * 重评2-P2-1（2026-09-09 全量重评 GLM-5.3）：chat SSE 重连 sync 快照收尾在途气泡。
 * 修复前：漏收 chat_done/chat_error 后重连，sync(chatRunning=false) 只复位
 * running/regenPending，在途气泡永久「生成中」（typing 不灭 + regenerate 要求
 * last.done 被锁死），且 P2-9 前提「未完成气泡只属于在途回合」被打破——此后
 * 新回合 + 错过 chat_turn 的重连会把新回合文本追加进旧气泡（跨回合并文）。
 * 修复：对齐 chat_error 的 R-7 收尾口径（在途气泡 done=true + currentIdx=-1）。
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

import { fetchChatHistory, regenerateChat } from '../../../src/studio/web-next/src/api/chat'
import { useChatStore } from '../../../src/studio/web-next/src/stores/chat'

const fetchMock = fetchChatHistory as ReturnType<typeof vi.fn>
const regenMock = regenerateChat as ReturnType<typeof vi.fn>

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
})

/** 本地构造一轮已完成对话（[user, assistant(done)]，走真实 dispatch 路径） */
function seedLocalTurn(chat: ReturnType<typeof useChatStore>): void {
  chat.pushUser('写第二章')
  chat.dispatch({ type: 'chat_start' })
  chat.dispatch({ type: 'chat_turn', turn: 0 })
  chat.dispatch({ type: 'chat_text', text: '好的，马上写。' })
  chat.dispatch({ type: 'chat_done' })
}

/** 带权威 seqs 的默认分支历史（regenerate 取 parentSeq 的数据源） */
const SEQ_HISTORY = {
  messages: [
    { role: 'user', content: '写第二章' },
    { role: 'assistant', content: '好的，马上写。' },
  ],
  seqs: [[10], [11]],
  branchId: 'b1',
}

describe('重评2-P2-1: sync(chatRunning=false) 收尾在途气泡', () => {
  it('在途气泡（currentIdx 指向未 done 气泡）+ sync(chatRunning=false) → done=true、currentIdx=-1、running=false', () => {
    const chat = useChatStore()
    chat.dispatch({ type: 'chat_start' })
    chat.dispatch({ type: 'chat_turn', turn: 0 })
    chat.dispatch({ type: 'chat_text', text: '半截回复' })
    // 漏收 chat_done/chat_error 后重连：服务端必补 sync 快照，后端已不在跑
    chat.dispatch({ type: 'sync', chatRunning: false })
    expect(chat.running).toBe(false)
    expect(chat.messages[0]!.done).toBe(true) // 修复前：气泡永久「生成中」
    // currentIdx 已复位：迟到的 chat_text 不再追加进已收尾气泡（R-7 同款行为断言）
    chat.dispatch({ type: 'chat_text', text: '迟到文本' })
    expect(chat.messages[0]!.content).toBe('半截回复')
  })

  it('同场景 regenPending=true → 一并复位：在途回合收尾后可再次重新生成（不被防重入标志 + last.done 双重锁死）', async () => {
    fetchMock.mockResolvedValueOnce(SEQ_HISTORY)
    regenMock.mockResolvedValueOnce({ ok: true })
    const chat = useChatStore()
    seedLocalTurn(chat)
    await chat.regenerate('书A') // POST 成功交接 → regenPending=true，视图截断到 user
    // SSE 接管：新回合在途（undone 气泡 + currentIdx 指向它），随后全断漏收 chat_done
    chat.dispatch({ type: 'chat_start' })
    chat.dispatch({ type: 'chat_turn', turn: 1 })
    chat.dispatch({ type: 'chat_text', text: '新回复半截' })
    chat.dispatch({ type: 'sync', chatRunning: false })
    expect(chat.running).toBe(false)
    expect(chat.messages[1]!.done).toBe(true) // 修复前：regenerate 的 last.done 前置被锁死
    chat.dispatch({ type: 'chat_text', text: '迟到' })
    expect(chat.messages[1]!.content).toBe('新回复半截')
    // regenPending 已随 sync 复位 + last.done 已收尾 → 第二次重新生成放行（修复前双重卡死）
    fetchMock.mockResolvedValueOnce(SEQ_HISTORY)
    regenMock.mockResolvedValueOnce({ ok: true })
    await chat.regenerate('书A')
    expect(regenMock).toHaveBeenCalledTimes(2)
  })

  it('P2-9 回归锚定: sync(chatRunning=true) 且 currentIdx 失效 → 仍重建索引到未 done 气泡（本次改动不波及 running=true 路径）', () => {
    const chat = useChatStore()
    chat.dispatch({ type: 'chat_start' })
    chat.dispatch({ type: 'chat_turn', turn: 0 })
    chat.dispatch({ type: 'chat_text', text: '第一回合半截' })
    chat.dispatch({ type: 'chat_turn', turn: 1 })
    chat.dispatch({ type: 'chat_text', text: '第二回合' })
    // 只收到第二回合的 chat_done：messages[1] 收尾 + currentIdx=-1；
    // messages[0] 仍 undone（漏收其收尾事件的残留）——P2-9 重建的目标形态
    chat.dispatch({ type: 'chat_done' })
    expect(chat.messages[0]!.done).toBe(false)
    // 重连 sync：后端仍在跑 → 重建到最后一个未 done 的 assistant 气泡（原有行为）
    chat.dispatch({ type: 'sync', chatRunning: true })
    expect(chat.running).toBe(true)
    expect(chat.messages[0]!.done).toBe(false) // 收尾分支不误伤 running=true 场景
    chat.dispatch({ type: 'chat_text', text: '续' })
    expect(chat.messages[0]!.content).toBe('第一回合半截续') // currentIdx 重建到 messages[0]
    expect(chat.messages[1]!.content).toBe('第二回合')
  })

  it('气泡已全 done（currentIdx=-1）→ sync(chatRunning=false) 无副作用', () => {
    const chat = useChatStore()
    chat.dispatch({ type: 'chat_start' })
    chat.dispatch({ type: 'chat_turn', turn: 0 })
    chat.dispatch({ type: 'chat_text', text: '完整回复' })
    chat.dispatch({ type: 'chat_done' })
    chat.dispatch({ type: 'sync', chatRunning: false })
    expect(chat.running).toBe(false)
    expect(chat.messages).toHaveLength(1)
    expect(chat.messages[0]!.done).toBe(true)
    expect(chat.messages[0]!.content).toBe('完整回复')
    // currentIdx 本就 -1：迟到文本静默丢弃（不错位追加、不新建气泡）
    chat.dispatch({ type: 'chat_text', text: '迟到' })
    expect(chat.messages).toHaveLength(1)
    expect(chat.messages[0]!.content).toBe('完整回复')
  })
})
