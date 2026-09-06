// @vitest-environment happy-dom
/**
 * R51-I-4（五十一轮）回归：存草稿入口的生成中闸（genBusy/running）。
 *
 * 流式生成中（wb.running 或本地在途锁）textOut 只是半章残稿——此前「存草稿并编辑」
 * 按钮/入口均不查 running，可存残稿并切离工作台。修复后：草稿卡按钮 genBusy 禁用
 * （第一道）+ onSaveDraft 入口兜底闸（键盘/后续新入口，F4 不完整水印同款双保险）。
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
import WbDraftCard from '../../../src/studio/web-next/src/components/workbench/WbDraftCard.vue'
import { useWorkbenchStore } from '../../../src/studio/web-next/src/stores/workbench'
import { useTreeStore } from '../../../src/studio/web-next/src/stores/tree'
import { useProviderStore } from '../../../src/studio/web-next/src/stores/provider'

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
  mocks.getDraftPrompt.mockResolvedValue({ prompt: '细纲语境', files: [] })
}

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  mocks.uiState.aiAvailable = true
  primeLoadApis()
})

async function mountView(): Promise<ReturnType<typeof mount>> {
  const w = mount(WorkbenchView, {
    props: { bookName: '书A' },
    global: {
      stubs: { ChatPanel: true, WbStateCard: true, WbAdvanced: true, WbHealCard: true, WbUsageCard: true },
    },
  })
  await flushPromises()
  return w
}

function saveBtnOf(w: ReturnType<typeof mount>) {
  return w.findComponent(WbDraftCard).find('button')
}

describe('R51-I-4: 存草稿入口的生成中闸', () => {
  it('wb.running（流式生成中）→ 按钮禁用 + 入口兜底拦截：saveDraft 不发、给出人话 toast', async () => {
    const wb = useWorkbenchStore()
    const w = await mountView()
    wb.textOut = '生成到一半的正文' // 半章残稿（旧实现可存）
    wb.running = true // SSE role_spawn 回流后的流式态
    await nextTick()

    const btn = saveBtnOf(w)
    expect((btn.element as HTMLButtonElement).disabled).toBe(true) // 第一道：按钮禁用
    expect(btn.text()).toContain('生成中')

    // 入口兜底（直发 save 事件模拟键盘/未来入口，f4 同款手法）
    w.findComponent(WbDraftCard).vm.$emit('save')
    await flushPromises()
    expect(mocks.saveDraft).not.toHaveBeenCalled()
    expect(mocks.uiToast).toHaveBeenCalledWith('生成进行中，正文尚不完整，请等生成结束或先中断再存草稿', 'error')
    w.unmount()
  })

  it('非生成态 → 闸放行（saveDraft 照发，不误伤常规保存）', async () => {
    vi.spyOn(useProviderStore(), 'refresh').mockResolvedValue(undefined)
    vi.spyOn(useTreeStore(), 'load').mockResolvedValue(undefined)
    mocks.saveDraft.mockResolvedValue({ ok: true, path: '写作/正文/0002-x.md', docId: 'doc_2', words: 7, snapshotted: false })
    const wb = useWorkbenchStore()
    const w = await mountView()
    wb.textOut = '完整正文'
    await nextTick()

    expect((saveBtnOf(w).element as HTMLButtonElement).disabled).toBe(false)
    w.findComponent(WbDraftCard).vm.$emit('save')
    await flushPromises()
    expect(mocks.saveDraft).toHaveBeenCalledTimes(1)
    expect(mocks.saveDraft.mock.calls[0]![0]).toBe('书A')
    w.unmount()
  })
})
