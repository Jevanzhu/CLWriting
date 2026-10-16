/**
 * AnalysisPanel 单章分析触发行直测（happy-dom，照本目录既有两个 AnalysisPanel 档的
 * 挂载范式：mock api/stores，mount 真组件）。
 *
 * 覆盖接线面：成本告知可见 → 动作打到 /analyze（kind 透传）→ 成功后复用面板既有
 * overview 加载路径（不发新刷新机制）→ 失败走既有 toast 通道且守卫同域；
 * 另锚 AI 不可达置灰与置灰提示带后端原因。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { reactive, nextTick } from 'vue'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

const mocks = vi.hoisted(() => ({
  analyzeChapter: vi.fn(),
  getAnalysisOverview: vi.fn(),
  autotag: vi.fn(),
  inferMeta: vi.fn(),
  uiToast: vi.fn(),
  // 可变槽位：组件 computed 依赖其响应性（切档/切书守卫用例要能改）
  wsState: { activeDocId: 'doc_1' as string | null },
  uiState: { aiAvailable: true as boolean | null, aiReasonText: '原因未知' },
}))

vi.mock('../../../../src/studio/web-next/src/api/analysis', () => ({
  analyzeChapter: mocks.analyzeChapter,
  getAnalysisOverview: mocks.getAnalysisOverview,
  autotag: mocks.autotag,
  inferMeta: mocks.inferMeta,
}))
vi.mock('../../../../src/studio/web-next/src/api/documents', () => ({
  updateDocMeta: vi.fn(async () => undefined),
}))
vi.mock('../../../../src/studio/web-next/src/stores/doc', () => ({
  useDocStore: vi.fn(() => ({ get: () => undefined, refresh: vi.fn(async () => {}) })),
}))
vi.mock('../../../../src/studio/web-next/src/stores/workspace', () => ({
  useWorkspaceStore: vi.fn(() => mocks.wsState),
}))
vi.mock('../../../../src/studio/web-next/src/stores/tree', () => ({
  useTreeStore: vi.fn(() => ({
    byDocId: new Map([['doc_1', { path: '写作/正文/0001-a.md' }]]),
  })),
}))
vi.mock('../../../../src/studio/web-next/src/stores/ui', () => ({
  useUiStore: vi.fn(() => ({ toast: mocks.uiToast, ...mocks.uiState })),
}))
vi.mock('lucide-vue-next', () => new Proxy({}, { get: () => ({ template: '<i/>' }) }))

import AnalysisPanel from '../../../../src/studio/web-next/src/components/panels/AnalysisPanel.vue'

mocks.wsState = reactive(mocks.wsState)

const OVERVIEW_EMPTY = { scoreTrend: [], emotionTrend: [], hooksTrend: [], style: null, allChapters: [] }

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  mocks.wsState.activeDocId = 'doc_1'
  mocks.uiState.aiAvailable = true
  mocks.uiState.aiReasonText = '原因未知'
  mocks.getAnalysisOverview.mockResolvedValue(OVERVIEW_EMPTY)
  mocks.analyzeChapter.mockResolvedValue({ envelope: { generatedAt: 't', model: 'm', sourceHash: 'h', payload: {} } })
  mocks.autotag.mockResolvedValue({})
  mocks.inferMeta.mockResolvedValue({})
})

function mountPanel(bookName = '书A'): ReturnType<typeof mount> {
  return mount(AnalysisPanel, { props: { bookName } })
}

function findBtn(w: ReturnType<typeof mount>, text: string) {
  return w.findAll('button').find((b) => b.text().includes(text))
}

describe('AnalysisPanel: 单章分析触发行', () => {
  it('点击「分析本章」→ analyzeChapter(书, 当前 docId, 默认 kind=score) + 成功刷新 overview', async () => {
    const w = mountPanel()
    await flushPromises()
    mocks.getAnalysisOverview.mockClear()
    await findBtn(w, '分析本章')!.trigger('click')
    await flushPromises()
    expect(mocks.analyzeChapter).toHaveBeenCalledTimes(1)
    expect(mocks.analyzeChapter).toHaveBeenCalledWith('书A', 'doc_1', 'score')
    // 刷新复用既有加载路径（重拉 analysis-overview），不另造机制
    expect(mocks.getAnalysisOverview).toHaveBeenCalledWith('书A')
    expect(mocks.uiToast).toHaveBeenCalledWith('分析完成', 'success')
    w.unmount()
  })

  it('kind 选择器改值 → 请求体跟着变（不是固定 score）', async () => {
    const w = mountPanel()
    await flushPromises()
    await w.find('.ap-kind').setValue('hooks')
    await findBtn(w, '分析本章')!.trigger('click')
    await flushPromises()
    expect(mocks.analyzeChapter).toHaveBeenCalledWith('书A', 'doc_1', 'hooks')
    w.unmount()
  })

  it('成本告知可见：消耗额度徽标常驻（动作前即可见），并带一句 tip', async () => {
    const w = mountPanel()
    await flushPromises()
    const badge = w.find('.ap-cost')
    expect(badge.exists()).toBe(true)
    expect(badge.text()).toContain('消耗额度')
    expect(badge.attributes('data-tip')).toBeTruthy()
    w.unmount()
  })

  it('失败（后端 GEN_FAIL 信封）→ 既有 toast 通道弹人话，且不刷新 overview', async () => {
    mocks.analyzeChapter.mockRejectedValueOnce(new Error('AI 生成失败，请稍后重试'))
    const w = mountPanel()
    await flushPromises()
    mocks.getAnalysisOverview.mockClear()
    await findBtn(w, '分析本章')!.trigger('click')
    await flushPromises()
    expect(mocks.uiToast).toHaveBeenCalledTimes(1)
    expect(mocks.uiToast.mock.calls[0]![0]).toContain('AI 生成失败')
    expect(String(mocks.uiToast.mock.calls[0]![1])).toBe('error')
    expect(mocks.getAnalysisOverview).not.toHaveBeenCalled()
    // 失败后按钮回可点（loading 复位，作者可重试）
    expect(findBtn(w, '分析本章')!.attributes('disabled')).toBeUndefined()
    w.unmount()
  })

  it('在途切档（activeDocId 变）后成功 → 不把 A 的刷新/成功提示落到 B', async () => {
    let resolveA!: (v: unknown) => void
    mocks.analyzeChapter.mockImplementationOnce(() => new Promise((res) => (resolveA = res)))
    const w = mountPanel()
    await flushPromises()
    await findBtn(w, '分析本章')!.trigger('click')
    // loading 态可见（分钟级调用期间作者要知道在跑）
    const btn = w.findAll('button').find((b) => b.text().includes('分析中'))!
    expect(btn.attributes('disabled')).toBeDefined()
    mocks.wsState.activeDocId = 'doc_2' // await 期间切档
    await nextTick()
    mocks.getAnalysisOverview.mockClear()
    resolveA({ envelope: { generatedAt: 't', model: 'm', sourceHash: 'h', payload: {} } })
    await flushPromises()
    expect(mocks.getAnalysisOverview).not.toHaveBeenCalled()
    expect(mocks.uiToast).not.toHaveBeenCalled()
    w.unmount()
  })

  it('在途切书（bookName prop 变）后失败 → 不弹 A 的失败到 B 界面', async () => {
    let rejectA!: (e: Error) => void
    mocks.analyzeChapter.mockImplementationOnce(
      () =>
        new Promise((_, rej) => {
          rejectA = rej
        }),
    )
    const w = mountPanel()
    await flushPromises()
    await findBtn(w, '分析本章')!.trigger('click')
    await w.setProps({ bookName: '书B' }) // await 期间切书
    rejectA(new Error('AI 生成失败，请稍后重试'))
    await flushPromises()
    expect(mocks.uiToast).not.toHaveBeenCalled()
    w.unmount()
  })

  it('AI 不可达 → 动作按钮置灰，tip 带后端原因', async () => {
    mocks.uiState.aiAvailable = false
    mocks.uiState.aiReasonText = '未配置 AI 服务供应商（请在设置页添加）'
    const w = mountPanel()
    await flushPromises()
    const btn = findBtn(w, '分析本章')!
    expect(btn.attributes('disabled')).toBeDefined()
    expect(btn.attributes('data-tip')).toContain('未配置 AI 服务供应商（请在设置页添加）')
    w.unmount()
  })

  it('AI 不可达 → 面板内另两处 AI 动作（分析标签 / AI 推断）同款置灰并带原因', async () => {
    mocks.uiState.aiAvailable = false
    mocks.uiState.aiReasonText = '未配置 AI 服务供应商（请在设置页添加）'
    const w = mountPanel()
    await flushPromises()
    for (const label of ['分析标签', 'AI 推断']) {
      const btn = findBtn(w, label)!
      expect(btn.attributes('disabled')).toBeDefined()
      expect(btn.attributes('data-tip')).toContain('未配置 AI 服务供应商（请在设置页添加）')
    }
    w.unmount()
  })

  it('分析标签在途 → 该按钮置灰，AI 推断按钮不受牵连', async () => {
    let resolveTag!: (v: unknown) => void
    mocks.autotag.mockImplementationOnce(() => new Promise((res) => (resolveTag = res)))
    const w = mountPanel()
    await flushPromises()
    await findBtn(w, '分析标签')!.trigger('click')
    expect(findBtn(w, '分析中')!.attributes('disabled')).toBeDefined()
    expect(findBtn(w, 'AI 推断')!.attributes('disabled')).toBeUndefined()
    resolveTag({})
    await flushPromises()
    expect(findBtn(w, '分析标签')!.attributes('disabled')).toBeUndefined()
    w.unmount()
  })

  it('AI 推断在途 → 该按钮置灰，分析标签按钮不受牵连', async () => {
    let resolveInfer!: (v: unknown) => void
    mocks.inferMeta.mockImplementationOnce(() => new Promise((res) => (resolveInfer = res)))
    const w = mountPanel()
    await flushPromises()
    await findBtn(w, 'AI 推断')!.trigger('click')
    expect(findBtn(w, '推断中')!.attributes('disabled')).toBeDefined()
    expect(findBtn(w, '分析标签')!.attributes('disabled')).toBeUndefined()
    resolveInfer({})
    await flushPromises()
    expect(findBtn(w, 'AI 推断')!.attributes('disabled')).toBeUndefined()
    w.unmount()
  })
})
