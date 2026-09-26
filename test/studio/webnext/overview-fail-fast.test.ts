// @vitest-environment happy-dom
/**
 * R0912-FE-P3-9（2026-09-11 重评-0911b 修复批）：OverviewView 主请求失败即止——
 * 原主请求（getOverview）失败后仍无条件发 3 个子请求（伏笔/节奏/分析）：整页已进
 * 错误态无处渲染，子请求纯属白耗。修复：catch 内 return（子请求不再发）；成功路径
 * 照旧并行拉取（回归锚）。代守卫语义（R72-11/R76-33）不属本项，不动。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import OverviewView from '../../../src/studio/web-next/src/views/OverviewView.vue'

const mocks = vi.hoisted(() => ({
  getOverview: vi.fn(),
  getForeshadows: vi.fn(),
  getRhythm: vi.fn(),
  getAnalysisOverview: vi.fn(),
}))

vi.mock('../../../src/studio/web-next/src/api/overview', () => ({
  getOverview: mocks.getOverview,
}))
vi.mock('../../../src/studio/web-next/src/api/foreshadows', () => ({
  getForeshadows: mocks.getForeshadows,
}))
vi.mock('../../../src/studio/web-next/src/api/rhythm', () => ({
  getRhythm: mocks.getRhythm,
}))
vi.mock('../../../src/studio/web-next/src/api/analysis', () => ({
  getAnalysisOverview: mocks.getAnalysisOverview,
}))

function mountView() {
  return mount(OverviewView, {
    props: { bookName: '测试书' },
    global: {
      stubs: { WordCurveChart: true, RhythmDistPanel: true, ShortProfileGaps: true },
    },
  })
}

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  mocks.getForeshadows.mockResolvedValue([])
  mocks.getRhythm.mockResolvedValue({ points: [], days: [] })
  mocks.getAnalysisOverview.mockResolvedValue({})
})

describe('OverviewView 主请求失败即止（R0912-FE-P3-9）', () => {
  it('主请求失败 → 整页错误态 + 3 个子请求一并不发', async () => {
    mocks.getOverview.mockRejectedValue(new Error('总览拉取失败'))
    const w = mountView()
    await flushPromises()
    expect(w.text()).toContain('总览载入失败')
    expect(mocks.getForeshadows).not.toHaveBeenCalled()
    expect(mocks.getRhythm).not.toHaveBeenCalled()
    expect(mocks.getAnalysisOverview).not.toHaveBeenCalled()
    w.unmount()
  })

  it('主请求成功 → 子请求照发（正常链回归锚）', async () => {
    mocks.getOverview.mockResolvedValue({
      identity: { kind: 'long', name: '书', title: '书', genre: '', created_at: '' },
      progress: { chapters: 1, words: 100, percent: 1, targetWords: null },
      timeline: [],
      streak: 0,
      recentDoc: null,
    })
    const w = mountView()
    await flushPromises()
    expect(mocks.getForeshadows).toHaveBeenCalledWith('测试书')
    expect(mocks.getRhythm).toHaveBeenCalledWith('测试书')
    expect(mocks.getAnalysisOverview).toHaveBeenCalledWith('测试书')
    w.unmount()
  })

  it('失败后点重试 → 重走全链（成功后子请求补发）', async () => {
    mocks.getOverview.mockRejectedValueOnce(new Error('fail'))
    const w = mountView()
    await flushPromises()
    expect(mocks.getForeshadows).not.toHaveBeenCalled()
    mocks.getOverview.mockResolvedValue({
      identity: { kind: 'long', name: '书', title: '书', genre: '', created_at: '' },
      progress: { chapters: 1, words: 100, percent: 1, targetWords: null },
      timeline: [],
      streak: 0,
      recentDoc: null,
    })
    await w
      .findAll('button')
      .find((b) => b.text().includes('重试'))!
      .trigger('click')
    await flushPromises()
    expect(mocks.getForeshadows).toHaveBeenCalledWith('测试书')
    w.unmount()
  })

  // 五轮重评修复批（F102）：loadFs 失败口径对齐 loadRhythm/loadAnalysis——失败置空。
  // 原 catch 只留痕不置空，重试失败后面板继续展示旧红/黄/绿统计（陈旧数据假健康）。
  // 路径注记：重试按钮仅存于错误态，单 mount 内「成功 → 再失败」二连发 UI 不可达
  //（成功态无任何 reload 触达）——「上一轮成功」的残留面用仓库先例 setupState 直植
  //（r1010b 同款 vm.$ 取法），触达的 catch 与真实链路同一处，判别面不受影响：
  // 修复前残留 2 条 → 面板照渲染；修复后置空 → 面板消失。
  it('F102：伏笔子请求失败 → 伏笔健康度面板置空（不残留上一轮旧统计）', async () => {
    const overview = {
      identity: { kind: 'long', name: '书', title: '书', genre: '', created_at: '' },
      progress: { chapters: 1, words: 100, percent: 1, targetWords: null },
      timeline: [],
      streak: 0,
      recentDoc: null,
    }
    // 首轮：主请求失败 → 整页错误态（失败即止，fs 不发；重试按钮在位）
    mocks.getOverview.mockRejectedValueOnce(new Error('总览失败'))
    mocks.getForeshadows.mockRejectedValue(new Error('伏笔失败'))
    const w = mountView()
    await flushPromises()
    expect(w.text()).toContain('总览载入失败')
    expect(mocks.getForeshadows).not.toHaveBeenCalled()

    // 植入「上一轮成功」的残留统计（setupState proxyRefs 解包，赋值落 ref.value）
    const st = (w.vm.$ as unknown as { setupState: Record<string, unknown> }).setupState
    st.foreshadows = [{ 状态: '未回收', 足迹: { risk: '红' } }, { 状态: '已回收' }]

    // 重试：主请求成功 + 伏笔子请求失败 → 面板置空（原实态：残留旧红/绿统计照渲染）
    mocks.getOverview.mockResolvedValue(overview)
    await w
      .findAll('button')
      .find((b) => b.text().includes('重试'))!
      .trigger('click')
    await flushPromises()
    expect(mocks.getForeshadows).toHaveBeenCalledTimes(1)
    expect(w.find('.fs-n').exists(), '失败置空，不得残留旧统计').toBe(false)
    expect(st.foreshadows).toEqual([]) // 组件态同一判别面
    w.unmount()
  })
})
