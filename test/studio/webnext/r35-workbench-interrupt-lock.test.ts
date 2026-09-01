// @vitest-environment happy-dom
/**
 * R35-39（三十五轮批 E）回归：WorkbenchView 中断按钮在途锁。
 * 修复前 onInterrupt 无本地锁，在途窗口内双击/连点会重复 POST /interrupt；
 * 修复后对齐 R69-29 家族（生成/全自动/细纲同款收口）：函数级 interruptPending
 * 锁 + 按钮 :disabled 双保险。mock 面与 mount 手法照 workbench-view-actions.test.ts。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { nextTick } from 'vue'

const mocks = vi.hoisted(() => ({
  getState: vi.fn(),
  spawnRole: vi.fn(),
  interrupt: vi.fn(),
  saveDraft: vi.fn(),
  autoWrite: vi.fn(),
  getDraftPrompt: vi.fn(),
  generateOutline: vi.fn(),
  generateLeadUpdates: vi.fn(),
  getConfig: vi.fn(),
  getTraceStats: vi.fn(),
  getCostStats: vi.fn(),
  getProviders: vi.fn(),
  uiToast: vi.fn(),
  uiState: { aiAvailable: true },
}))

vi.mock('../../../src/studio/web-next/src/api/stream', () => ({
  getState: mocks.getState,
  spawnRole: mocks.spawnRole,
  interrupt: mocks.interrupt,
  saveDraft: mocks.saveDraft,
  autoWrite: mocks.autoWrite,
  getDraftPrompt: mocks.getDraftPrompt,
  generateOutline: mocks.generateOutline,
  generateLeadUpdates: mocks.generateLeadUpdates,
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
vi.mock('../../../src/studio/web-next/src/stores/ui', () => ({
  useUiStore: vi.fn(() => ({ toast: mocks.uiToast, aiAvailable: mocks.uiState.aiAvailable })),
}))
vi.mock('lucide-vue-next', () => new Proxy({}, { get: () => ({ template: '<i/>' }) }))

import WorkbenchView from '../../../src/studio/web-next/src/views/WorkbenchView.vue'
import { useWorkbenchStore } from '../../../src/studio/web-next/src/stores/workbench'

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
  mocks.uiState.aiAvailable = true
  primeLoadApis()
})

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

describe('R35-39: WorkbenchView 中断在途锁', () => {
  it('在途窗口双击 → interrupt 只发一次；期间按钮 disabled；完成后解锁 + toast', async () => {
    let resolveInterrupt!: () => void
    mocks.interrupt.mockImplementationOnce(() => new Promise<void>((r) => { resolveInterrupt = r }))
    const w = await mountRunning()

    const click = interruptBtn(w).trigger('click')
    await nextTick()
    // 在途窗口：按钮禁用 + 函数锁生效——再点不重复发
    expect(interruptBtn(w).attributes('disabled')).toBeDefined()
    await interruptBtn(w).trigger('click')
    expect(mocks.interrupt).toHaveBeenCalledTimes(1)
    expect(mocks.interrupt).toHaveBeenCalledWith('书A')

    resolveInterrupt()
    await click
    await flushPromises()
    expect(mocks.uiToast).toHaveBeenCalledWith('已中断', 'info')
    expect(interruptBtn(w).attributes('disabled')).toBeUndefined()
    w.unmount()
  })

  it('中断失败 → 锁释放（finally）、错误入 err 不致未处理拒绝', async () => {
    mocks.interrupt.mockRejectedValueOnce(new Error('stream down'))
    const w = await mountRunning()
    await interruptBtn(w).trigger('click')
    await flushPromises()
    expect(mocks.interrupt).toHaveBeenCalledTimes(1)
    // 锁已释放：按钮可再点（可重试）
    expect(interruptBtn(w).attributes('disabled')).toBeUndefined()
    w.unmount()
  })
})
