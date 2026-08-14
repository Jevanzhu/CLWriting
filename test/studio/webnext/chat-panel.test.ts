// @vitest-environment happy-dom
/**
 * ChatPanel 组件交互测试（评审测试缺口补强）。
 *
 * 覆盖 P1/P2 修复的行为验证（非 store 逻辑——那是 chat-store.test.ts 的职责）：
 * - P1-2 停止按钮（busy 切换 + click 调 interrupt）
 * - P1-4/P2-K 清空顺序（先 interrupt 再 clearChatHistory 再 clear）
 * - P2-L 发送失败回滚（popUser）
 * - Enter 发送 / Shift+Enter 换行
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { nextTick } from 'vue'
import ChatPanel from '../../../src/studio/web-next/src/components/panels/ChatPanel.vue'
import { useChatStore } from '../../../src/studio/web-next/src/stores/chat'

// ── mock API 层（拦截真实网络请求） ────────────────────

const mocks = vi.hoisted(() => ({
  sendChat: vi.fn(),
  confirmTool: vi.fn(),
  clearChatHistory: vi.fn(),
  interrupt: vi.fn(),
}))

vi.mock('../../../src/studio/web-next/src/api/chat', () => ({
  sendChat: mocks.sendChat,
  confirmTool: mocks.confirmTool,
  clearChatHistory: mocks.clearChatHistory,
}))

vi.mock('../../../src/studio/web-next/src/api/stream', () => ({
  interrupt: mocks.interrupt,
}))

vi.mock('../../../src/studio/web-next/src/composables/useChatTier', () => ({
  useChatTier: () => ({
    chatTier: null,
    activeModel: 'test-model',
    activeEffort: 'low',
    models: ['test-model'],
    tierLoading: false,
    onModelChange: vi.fn(),
    onEffortChange: vi.fn(),
  }),
  EFFORT_LEVELS: ['low', 'medium', 'high'],
}))

beforeEach(() => {
  setActivePinia(createPinia())
  mocks.sendChat.mockReset()
  mocks.confirmTool.mockReset()
  mocks.clearChatHistory.mockReset()
  mocks.interrupt.mockReset()
  // 默认成功 resolve
  mocks.sendChat.mockResolvedValue(undefined)
  mocks.clearChatHistory.mockResolvedValue(undefined)
  mocks.interrupt.mockResolvedValue(undefined)
})

function mountPanel(props: Record<string, unknown> = {}) {
  return mount(ChatPanel, {
    props: { bookName: 'test-book', ...props },
  })
}

// ── 发送交互 ──────────────────────────────────────────

describe('ChatPanel: 发送交互', () => {
  it('输入文本 + Enter → 调 sendChat', async () => {
    const w = mountPanel()
    const textarea = w.find('.chat-input')
    await textarea.setValue('你好')
    await textarea.trigger('keydown', { key: 'Enter' })
    expect(mocks.sendChat).toHaveBeenCalledWith(
      'test-book',
      expect.objectContaining({ message: '你好' }),
    )
  })

  it('Shift+Enter → 不调 sendChat（换行）', async () => {
    const w = mountPanel()
    const textarea = w.find('.chat-input')
    await textarea.setValue('你好')
    await textarea.trigger('keydown', { key: 'Enter', shiftKey: true })
    expect(mocks.sendChat).not.toHaveBeenCalled()
  })

  it('空输入 + Enter → 不调 sendChat', async () => {
    const w = mountPanel()
    await w.find('.chat-input').trigger('keydown', { key: 'Enter' })
    expect(mocks.sendChat).not.toHaveBeenCalled()
  })
})

// ── P2-L 发送失败回滚 ─────────────────────────────────

describe('ChatPanel: 发送失败回滚（P2-L）', () => {
  it('sendChat reject → popUser 回滚 + 设 error', async () => {
    mocks.sendChat.mockRejectedValue(new Error('冲突'))
    const chat = useChatStore()
    const w = mountPanel()
    const textarea = w.find('.chat-input')
    await textarea.setValue('你好')
    await textarea.trigger('keydown', { key: 'Enter' })
    await flushPromises()
    expect(mocks.sendChat).toHaveBeenCalled()
    // pushUser 被 popUser 回滚
    expect(chat.messages).toHaveLength(0)
    expect(typeof chat.error).toBe('string')
  })
})

// ── P1-2 停止按钮 ─────────────────────────────────────

describe('ChatPanel: 停止按钮（P1-2）', () => {
  it('busy 时显示停止按钮 → click 调 interrupt', async () => {
    const chat = useChatStore()
    chat.running = true
    const w = mountPanel()
    await nextTick()
    const stopBtn = w.find('.chat-stop-btn')
    expect(stopBtn.exists()).toBe(true)
    await stopBtn.trigger('click')
    expect(mocks.interrupt).toHaveBeenCalledWith('test-book')
  })

  it('非 busy 时显示发送按钮（无停止按钮）', async () => {
    const w = mountPanel()
    await nextTick()
    expect(w.find('.chat-stop-btn').exists()).toBe(false)
    expect(w.find('.chat-send-btn').exists()).toBe(true)
  })
})

// ── P1-4/P2-K 清空 ───────────────────────────────────

describe('ChatPanel: 清空（P1-4/P2-K）', () => {
  it('清空按钮 → clearChatHistory + chat.clear', async () => {
    const chat = useChatStore()
    chat.pushUser('旧消息')
    const w = mountPanel()
    await nextTick()
    const clearBtn = w.find('.composer-clear')
    expect(clearBtn.exists()).toBe(true)
    await clearBtn.trigger('click')
    await flushPromises()
    expect(mocks.clearChatHistory).toHaveBeenCalledWith('test-book')
    expect(chat.messages).toHaveLength(0)
  })

  it('清空时 running → 先 interrupt 再 clearChatHistory', async () => {
    const chat = useChatStore()
    chat.pushUser('消息')
    chat.running = true
    const w = mountPanel()
    await nextTick()
    await w.find('.composer-clear').trigger('click')
    await flushPromises()
    expect(mocks.interrupt).toHaveBeenCalledWith('test-book')
    expect(mocks.clearChatHistory).toHaveBeenCalledWith('test-book')
    // interrupt 必须在 clearChatHistory 之前
    expect(mocks.interrupt.mock.invocationCallOrder[0] ?? 0).toBeLessThan(
      mocks.clearChatHistory.mock.invocationCallOrder[0] ?? 0,
    )
  })
})
