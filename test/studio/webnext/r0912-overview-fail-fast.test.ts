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
    await w.findAll('button').find((b) => b.text().includes('重试'))!.trigger('click')
    await flushPromises()
    expect(mocks.getForeshadows).toHaveBeenCalledWith('测试书')
    w.unmount()
  })
})
