// @vitest-environment happy-dom
/**
 * 0918独立重评修复批（E004）回归：interrupt() 返回 {ok, interrupted} 的消费面。
 *
 * 服务端实际返回 {ok, interrupted}（interrupted=false = 当前没有在途生成）——原前端
 * 签名丢弃返回体，两个消费点都无法区分「已中断」与「本来就没在跑」。修复后：
 * - useChatComposer.stopChat：interrupted=false → toast「当前没有正在进行的生成」；
 * - WorkbenchView.onInterrupt：interrupted=false → 同文案（替代误导性「已中断」），
 *   interrupted=true 维持「已中断」；返回体缺省（旧 mock/异常形态）维持原口径不误报。
 *
 * WorkbenchView harness 照 workbench-interrupt-guard.test.ts；ChatPanel 面照
 * chat-panel.test.ts（api/chat + useChatTier mock）。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { nextTick } from 'vue'

const mocks = vi.hoisted(() => ({
  // api/workbench
  getState: vi.fn(),
  spawnRole: vi.fn(),
  interrupt: vi.fn(),
  saveDraft: vi.fn(),
  autoWrite: vi.fn(),
  getDraftPrompt: vi.fn(),
  generateOutline: vi.fn(),
  generateLeadUpdates: vi.fn(),
  // 其它 WorkbenchView 依赖
  getConfig: vi.fn(),
  getTraceStats: vi.fn(),
  getCostStats: vi.fn(),
  getProviders: vi.fn(),
  // api/chat（ChatPanel 面）
  sendChat: vi.fn(),
  clearChatHistory: vi.fn(),
  confirmTool: vi.fn(),
  fetchChatHistory: vi.fn(),
  fetchChatBranches: vi.fn(),
  regenerateChat: vi.fn(),
}))

vi.mock('../../../src/studio/web-next/src/api/workbench', () => ({
  getState: mocks.getState,
  spawnRole: mocks.spawnRole,
  interrupt: mocks.interrupt,
  saveDraft: mocks.saveDraft,
  autoWrite: mocks.autoWrite,
  getDraftPrompt: mocks.getDraftPrompt,
  generateOutline: mocks.generateOutline,
  generateLeadUpdates: mocks.generateLeadUpdates,
}))
vi.mock('../../../src/studio/web-next/src/api/chat', () => ({
  sendChat: mocks.sendChat,
  clearChatHistory: mocks.clearChatHistory,
  confirmTool: mocks.confirmTool,
  fetchChatHistory: mocks.fetchChatHistory,
  fetchChatBranches: mocks.fetchChatBranches,
  regenerateChat: mocks.regenerateChat,
}))
vi.mock('../../../src/studio/web-next/src/api/books', () => ({
  getConfig: mocks.getConfig,
}))
vi.mock('../../../src/studio/web-next/src/api/trace-stats', () => ({
  getTraceStats: mocks.getTraceStats,
}))
vi.mock('../../../src/studio/web-next/src/api/cost-stats', () => ({
  getCostStats: mocks.getCostStats,
}))
vi.mock('../../../src/studio/web-next/src/api/providers', () => ({
  getProviders: mocks.getProviders,
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
vi.mock('lucide-vue-next', () => new Proxy({}, { get: () => ({ template: '<i/>' }) }))

import WorkbenchView from '../../../src/studio/web-next/src/views/WorkbenchView.vue'
import ChatPanel from '../../../src/studio/web-next/src/components/panels/ChatPanel.vue'
import { useWorkbenchStore } from '../../../src/studio/web-next/src/stores/workbench'
import { useChatStore } from '../../../src/studio/web-next/src/stores/chat'
import { useUiStore } from '../../../src/studio/web-next/src/stores/ui'

function primeLoadApis(): void {
  mocks.getState.mockResolvedValue({
    identity: { kind: 'long', name: '书A', title: '', genre: '', created_at: '', wordsTarget: null },
    progress: { chapters: 1, words: 100, percent: 1, targetWords: null },
    nextChapter: 2,
    timeline: [],
    streak: 1,
  })
  mocks.getTraceStats.mockResolvedValue({ ruleHits: [], byTask: [] })
  mocks.getCostStats.mockResolvedValue({ today: { calls: 0, cost: 0 }, recent: [] })
  mocks.getProviders.mockResolvedValue({ providers: [], tiers: null, currentModel: null })
}

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  primeLoadApis()
})

/** ui store 的 toast spy（真实 store，挂数后在断言口收口） */
function spyToast() {
  const ui = useUiStore()
  return vi.spyOn(ui, 'toast')
}

describe('E004: WorkbenchView 中断按钮消费 interrupted 字段', () => {
  async function mountRunning(): Promise<ReturnType<typeof mount>> {
    useWorkbenchStore().running = true // genBusy → 「中断」按钮置换「生成」
    const w = mount(WorkbenchView, {
      props: { bookName: '书A' },
      global: { stubs: { ChatPanel: true, WbStateCard: true, WbAdvanced: true, WbHealCard: true, WbUsageCard: true } },
    })
    await flushPromises()
    return w
  }

  function interruptBtn(w: ReturnType<typeof mount>) {
    const b = w.findAll('button').find((x) => x.text().includes('中断'))
    if (!b) throw new Error('中断按钮未渲染（wb.running 未生效？）')
    return b
  }

  it('interrupted=true → 「已中断」，不出「没有在生成」提示', async () => {
    mocks.interrupt.mockResolvedValue({ ok: true, interrupted: true })
    const toast = spyToast()
    const w = await mountRunning()
    await interruptBtn(w).trigger('click')
    await flushPromises()
    expect(mocks.interrupt).toHaveBeenCalledWith('书A')
    expect(toast).toHaveBeenCalledWith('已中断', 'info')
    const msgs = toast.mock.calls.map((c) => String(c[0]))
    expect(msgs).not.toContain('当前没有正在进行的生成')
    w.unmount()
  })

  it('interrupted=false → 「当前没有正在进行的生成」，不再误导性「已中断」', async () => {
    mocks.interrupt.mockResolvedValue({ ok: true, interrupted: false })
    const toast = spyToast()
    const w = await mountRunning()
    await interruptBtn(w).trigger('click')
    await flushPromises()
    expect(toast).toHaveBeenCalledWith('当前没有正在进行的生成', 'info')
    const msgs = toast.mock.calls.map((c) => String(c[0]))
    expect(msgs).not.toContain('已中断')
    w.unmount()
  })
})

describe('E004: ChatPanel 停止按钮（stopChat）消费 interrupted 字段', () => {
  async function mountWithRunningChat(): Promise<ReturnType<typeof mount>> {
    useChatStore().running = true
    const w = mount(ChatPanel, { props: { bookName: 'test-book' } })
    await nextTick()
    return w
  }

  it('interrupted=false → toast「当前没有正在进行的生成」', async () => {
    mocks.interrupt.mockResolvedValue({ ok: true, interrupted: false })
    const toast = spyToast()
    const w = await mountWithRunningChat()
    const stopBtn = w.find('.chat-stop-btn')
    expect(stopBtn.exists()).toBe(true)
    await stopBtn.trigger('click')
    await flushPromises()
    expect(mocks.interrupt).toHaveBeenCalledWith('test-book')
    expect(toast).toHaveBeenCalledWith('当前没有正在进行的生成', 'info')
    w.unmount()
  })

  it('interrupted=true → 正常中断不 toast；返回体缺省（旧形态）不误报不崩溃', async () => {
    const toast = spyToast()
    const w = await mountWithRunningChat()
    // true：静默（既有口径）
    mocks.interrupt.mockResolvedValueOnce({ ok: true, interrupted: true })
    await w.find('.chat-stop-btn').trigger('click')
    await flushPromises()
    expect(toast).not.toHaveBeenCalledWith('当前没有正在进行的生成', 'info')
    // 缺省：守卫 r && ... 短路，不误报不崩溃
    mocks.interrupt.mockResolvedValueOnce(undefined)
    await w.find('.chat-stop-btn').trigger('click')
    await flushPromises()
    expect(mocks.interrupt).toHaveBeenCalledTimes(2)
    expect(toast).not.toHaveBeenCalledWith('当前没有正在进行的生成', 'info')
    w.unmount()
  })
})
