// @vitest-environment happy-dom
/**
 * R40-36/37/47（四十轮）回归：chat 发送链守卫与章节速选菜单 Esc。
 * harness 对齐 chat-panel.test.ts（ChatPanel 挂 useChatComposer 的组件级验证）。
 *
 * - R40-36：入队成功分支书名复检——await 窗口切书后入队提示不再写进 B 书对话区。
 * - R40-37：失败回滚按本次幽灵气泡 id 定位——上下文换代后 popUser 不再盲弹「当前
 *   末条」；错误文案用闭包内捕获的本次错误。
 * - R40-47：章节速选菜单开时 Esc 关闭自身且不外溢（ModelPicker R37-36 手法）。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { nextTick } from 'vue'
import ChatPanel from '../../../src/studio/web-next/src/components/panels/ChatPanel.vue'
import { useChatStore } from '../../../src/studio/web-next/src/stores/chat'

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
  mocks.sendChat.mockResolvedValue(undefined)
  mocks.clearChatHistory.mockResolvedValue(undefined)
  mocks.interrupt.mockResolvedValue(undefined)
})

function mountPanel(props: Record<string, unknown> = {}) {
  return mount(ChatPanel, { props: { bookName: '书A', ...props } })
}

async function send(w: ReturnType<typeof mountPanel>, text = '你好'): Promise<void> {
  await w.find('.chat-input').setValue(text)
  await w.find('.chat-input').trigger('keydown', { key: 'Enter' })
}

describe('R40-37: 失败回滚按幽灵气泡 id 定位', () => {
  it('send 在途时上下文被追加外来消息 → reject 后外来消息不被 popUser 误弹', async () => {
    let rejectSend!: (e: Error) => void
    mocks.sendChat.mockImplementation(() => new Promise((_, rej) => { rejectSend = rej }))
    const chat = useChatStore()
    const w = mountPanel()
    await send(w)
    expect(chat.messages.length).toBe(1) // 幽灵气泡已入区
    // 上下文换代：外来消息成为「当前末条」（旧实现 popUser 会盲弹它）
    chat.messages.push({ id: 'foreign-1', role: 'user', text: '别弹我' } as unknown as (typeof chat.messages)[number])
    rejectSend(new Error('本次发送炸了'))
    await flushPromises()
    expect(chat.messages.some((m) => m.id === 'foreign-1')).toBe(true)
    expect(chat.error).toContain('本次发送炸了')
  })

  it('末条仍是本次幽灵气泡 → 照常回滚（不回归 P2-L）', async () => {
    mocks.sendChat.mockRejectedValue(new Error('冲突'))
    const chat = useChatStore()
    const w = mountPanel()
    await send(w)
    await flushPromises()
    expect(chat.messages).toHaveLength(0)
    expect(typeof chat.error).toBe('string')
  })
})

describe('R40-36: 入队成功分支书名复检', () => {
  it('同书入队 → notice 照常提示（不回归）', async () => {
    mocks.sendChat.mockResolvedValue({ queued: true })
    const chat = useChatStore()
    const w = mountPanel()
    await send(w)
    await flushPromises()
    expect(chat.notice).toContain('队列')
  })

  it('await 窗口切书 → 不把入队提示写进 B 书对话区', async () => {
    let resolveSend!: (v: { queued: boolean }) => void
    mocks.sendChat.mockImplementation(() => new Promise((res) => { resolveSend = res }))
    const chat = useChatStore()
    const w = mountPanel()
    await send(w)
    await w.setProps({ bookName: '书B' }) // await 窗口内切书
    resolveSend({ queued: true })
    await flushPromises()
    expect(chat.notice).toBeFalsy()
  })
})

describe('R40-47: 章节速选菜单 Esc 关闭', () => {
  it('菜单开 → Esc 关闭；document capture 监听生效', async () => {
    const w = mountPanel()
    await w.find('.composer-chapter').trigger('click')
    expect(w.find('.chapter-menu').exists()).toBe(true)
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await nextTick()
    expect(w.find('.chapter-menu').exists()).toBe(false)
  })

  it('菜单未开 → Esc 不误触（监听空转）', async () => {
    const w = mountPanel()
    expect(w.find('.chapter-menu').exists()).toBe(false)
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await nextTick()
    expect(w.find('.chapter-menu').exists()).toBe(false)
  })
})
