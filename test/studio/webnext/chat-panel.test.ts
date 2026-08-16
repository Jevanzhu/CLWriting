// @vitest-environment happy-dom
/**
 * ChatPanel 组件交互测试（评审测试缺口补强）。
 *
 * 覆盖 P1/P2 修复的行为验证（非 store 逻辑——那是 chat-store.test.ts 的职责）：
 * - P1-2 停止按钮（busy 切换 + click 调 interrupt）
 * - P1-4/P2-K 清空顺序（先 interrupt 再 clearChatHistory 再 clear）
 * - P2-L 发送失败回滚（popUser）
 * - Enter 发送 / Shift+Enter 换行
 * - G1 重新生成按钮（末条已完成才渲染/running 禁用/点击调 regenerate）
 * - G1 变体切换器（双变体组才渲染/标签 n/m/首尾循环/running 禁用）
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { nextTick } from 'vue'
import ChatPanel from '../../../src/studio/web-next/src/components/panels/ChatPanel.vue'
import { useChatStore } from '../../../src/studio/web-next/src/stores/chat'
import { useUiStore } from '../../../src/studio/web-next/src/stores/ui'

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

// ── G1 重新生成 + 变体切换 ────────────────────────────

describe('ChatPanel: 重新生成按钮（G1）', () => {
  it('末条已完成 assistant → 渲染按钮，点击调 chat.regenerate', async () => {
    const chat = useChatStore()
    const regen = vi.spyOn(chat, 'regenerate').mockResolvedValue(undefined)
    chat.messages.push(
      { id: 'u1', role: 'user', content: '写一段', done: true, tools: [], seq: 1 },
      { id: 'a1', role: 'assistant', content: '答案', done: true, tools: [], seq: 2 },
    )
    const w = mountPanel()
    await nextTick()
    const btn = w.find('.chat-regen-btn')
    expect(btn.exists()).toBe(true)
    expect(btn.attributes('disabled')).toBeUndefined()
    await btn.trigger('click')
    expect(regen).toHaveBeenCalledWith('test-book', undefined)
  })

  it('非末条 assistant（后面还有消息）→ 不渲染按钮', async () => {
    const chat = useChatStore()
    chat.messages.push(
      { id: 'u1', role: 'user', content: '问', done: true, tools: [], seq: 1 },
      { id: 'a1', role: 'assistant', content: '答', done: true, tools: [], seq: 2 },
      { id: 'u2', role: 'user', content: '再问', done: true, tools: [], seq: 3 },
    )
    const w = mountPanel()
    await nextTick()
    expect(w.find('.chat-regen-btn').exists()).toBe(false)
  })

  it('running 中 → 按钮禁用', async () => {
    const chat = useChatStore()
    chat.messages.push(
      { id: 'u1', role: 'user', content: '问', done: true, tools: [], seq: 1 },
      { id: 'a1', role: 'assistant', content: '答', done: true, tools: [], seq: 2 },
    )
    chat.running = true
    const w = mountPanel()
    await nextTick()
    expect(w.find('.chat-regen-btn').attributes('disabled')).toBeDefined()
  })
})

describe('ChatPanel: 变体切换器（G1）', () => {
  /** 双变体组（同 parentSeq=1）+ 一条可见 assistant（seq 指定落在哪个组） */
  function seedBranched(chat: ReturnType<typeof useChatStore>, visibleSeq: number): void {
    chat.messages.push(
      { id: 'u1', role: 'user', content: '写一段', done: true, tools: [], seq: 1 },
      { id: 'a1', role: 'assistant', content: `答案@${visibleSeq}`, done: true, tools: [], seq: visibleSeq },
    )
    chat.branches = [
      { branchId: 'b1', messageCount: 1, rootSeq: 2, lastSeq: 2, isDefault: false, parentSeq: 1 },
      { branchId: 'b2', messageCount: 1, rootSeq: 3, lastSeq: 3, isDefault: true, parentSeq: 1 },
    ]
  }

  it('seq 落入同 parent 双变体组 → 渲染切换器 + 标签 1/2；组外消息不渲染', async () => {
    const chat = useChatStore()
    seedBranched(chat, 2)
    // 组外后续回合：seq 5 不在任何分支区间，不应出现切换器
    chat.messages.push(
      { id: 'u2', role: 'user', content: '追问', done: true, tools: [], seq: 4 },
      { id: 'a2', role: 'assistant', content: '后答', done: true, tools: [], seq: 5 },
    )
    const w = mountPanel()
    await nextTick()
    const switchers = w.findAll('.chat-variant')
    expect(switchers).toHaveLength(1)
    expect(w.find('.chat-variant-label').text()).toBe('1/2')
  })

  it('仅单变体组（无兄弟分支）→ 不渲染切换器', async () => {
    const chat = useChatStore()
    seedBranched(chat, 2)
    chat.branches = [
      { branchId: 'b1', messageCount: 1, rootSeq: 2, lastSeq: 2, isDefault: true, parentSeq: 1 },
    ]
    const w = mountPanel()
    await nextTick()
    expect(w.find('.chat-variant').exists()).toBe(false)
  })

  it('点击 ▶ → 调 chat.switchBranch 切到下一变体；末位循环回首', async () => {
    const chat = useChatStore()
    seedBranched(chat, 3) // 可见消息落在 b2（index 1）
    const switchSpy = vi.spyOn(chat, 'switchBranch').mockResolvedValue(undefined)
    const w = mountPanel()
    await nextTick()
    expect(w.find('.chat-variant-label').text()).toBe('2/2')
    const [, nextBtn] = w.findAll('.chat-variant-btn')
    await nextBtn!.trigger('click')
    expect(switchSpy).toHaveBeenCalledWith('test-book', 'b1') // (1+1+2)%2=0 → 循环回首
  })

  it('点击 ◀ → 调 chat.switchBranch 切到上一变体', async () => {
    const chat = useChatStore()
    seedBranched(chat, 2) // 可见消息落在 b1（index 0）
    const switchSpy = vi.spyOn(chat, 'switchBranch').mockResolvedValue(undefined)
    const w = mountPanel()
    await nextTick()
    const [prevBtn] = w.findAll('.chat-variant-btn')
    await prevBtn!.trigger('click')
    expect(switchSpy).toHaveBeenCalledWith('test-book', 'b2') // (0-1+2)%2=1 → 循环到末
  })

  it('running 中 → 切换按钮禁用且点击不调 switchBranch', async () => {
    const chat = useChatStore()
    seedBranched(chat, 2)
    const switchSpy = vi.spyOn(chat, 'switchBranch').mockResolvedValue(undefined)
    chat.running = true
    const w = mountPanel()
    await nextTick()
    const btns = w.findAll('.chat-variant-btn')
    for (const b of btns) expect(b.attributes('disabled')).toBeDefined()
    await btns[1]!.trigger('click')
    expect(switchSpy).not.toHaveBeenCalled()
  })
})

// ── P1-4/P2-K 清空（CC-P2-16 起加 danger 二次确认） ────

describe('ChatPanel: 清空（P1-4/P2-K）', () => {
  it('清空按钮 → 确认后 clearChatHistory + chat.clear', async () => {
    const chat = useChatStore()
    chat.pushUser('旧消息')
    const w = mountPanel()
    await nextTick()
    const clearBtn = w.find('.composer-clear')
    expect(clearBtn.exists()).toBe(true)
    await clearBtn.trigger('click')
    // CC-P2-16：清空连服务端历史一起删（不可恢复）→ 先弹 danger 确认
    const ui = useUiStore()
    expect(ui.confirmState?.danger).toBe(true)
    ui.resolveConfirm(true)
    await flushPromises()
    expect(mocks.clearChatHistory).toHaveBeenCalledWith('test-book')
    expect(chat.messages).toHaveLength(0)
  })

  it('确认弹窗取消 → 不清空（CC-P2-16）', async () => {
    const chat = useChatStore()
    chat.pushUser('旧消息')
    const w = mountPanel()
    await nextTick()
    await w.find('.composer-clear').trigger('click')
    useUiStore().resolveConfirm(false)
    await flushPromises()
    expect(mocks.clearChatHistory).not.toHaveBeenCalled()
    expect(chat.messages).toHaveLength(1)
  })

  it('清空时 running → 先 interrupt 再 clearChatHistory', async () => {
    const chat = useChatStore()
    chat.pushUser('消息')
    chat.running = true
    const w = mountPanel()
    await nextTick()
    await w.find('.composer-clear').trigger('click')
    useUiStore().resolveConfirm(true)
    await flushPromises()
    expect(mocks.interrupt).toHaveBeenCalledWith('test-book')
    expect(mocks.clearChatHistory).toHaveBeenCalledWith('test-book')
    // interrupt 必须在 clearChatHistory 之前
    expect(mocks.interrupt.mock.invocationCallOrder[0] ?? 0).toBeLessThan(
      mocks.clearChatHistory.mock.invocationCallOrder[0] ?? 0,
    )
  })
})
