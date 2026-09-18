// @vitest-environment happy-dom
/**
 * 0918二轮修复批（E103）回归：chat_turn 推新气泡即修剪（消息条数上限中途生效）。
 *
 * 原 trimMessages 只挂在 chat_done / pushUser / seedFromHistory 三处收尾——单次长跑
 * （多回合工具链连转，每回合一条 chat_turn）超过 CHAT_HISTORY_LIMIT 时要等整跑收尾
 * 才裁剪，期间 messages 条数无界膨胀。修复：chat_turn 分支 push 后补 trimMessages()
 * （只裁头部并同步偏移 currentIdx，在途回合气泡恒在尾部不受影响）。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'

vi.mock('../../../src/studio/web-next/src/api/chat', () => ({
  sendChat: vi.fn(),
  clearChatHistory: vi.fn(),
  confirmTool: vi.fn(),
  fetchChatHistory: vi.fn(),
  fetchChatBranches: vi.fn(),
  regenerateChat: vi.fn(),
}))

import { useChatStore } from '../../../src/studio/web-next/src/stores/chat'
import { CHAT_HISTORY_LIMIT } from '../../../src/studio/web-next/src/shared/chat-history'

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
})

describe('E103: chat_turn 推新气泡的中途修剪', () => {
  it(`连发超 ${CHAT_HISTORY_LIMIT} 条 chat_turn → 长度钉在上限（修复前：等整跑收尾才裁）`, () => {
    const chat = useChatStore()
    chat.dispatch({ type: 'chat_start' })
    for (let i = 0; i < CHAT_HISTORY_LIMIT + 37; i++) {
      chat.dispatch({ type: 'chat_turn', turn: i })
    }
    // 修复点：push 即修剪，不等 chat_done
    expect(chat.messages).toHaveLength(CHAT_HISTORY_LIMIT)
    // 不等收尾时 running 仍为 true（证明是「中途」而非收尾裁剪）
    expect(chat.running).toBe(true)
  })

  it('修剪后 currentIdx 偏移正确：chat_text 仍追加到最新在途回合气泡', () => {
    const chat = useChatStore()
    chat.dispatch({ type: 'chat_start' })
    for (let i = 0; i < CHAT_HISTORY_LIMIT + 5; i++) {
      chat.dispatch({ type: 'chat_turn', turn: i })
    }
    chat.dispatch({ type: 'chat_text', text: '尾部文本' })

    const last = chat.messages[chat.messages.length - 1]!
    expect(last.role).toBe('assistant')
    expect(last.done).toBe(false)
    expect(last.content).toBe('尾部文本') // 追加到正确气泡（无索引错位）
    // 头部被裁的是最旧回合，条数守恒在上限
    expect(chat.messages).toHaveLength(CHAT_HISTORY_LIMIT)
  })
})
