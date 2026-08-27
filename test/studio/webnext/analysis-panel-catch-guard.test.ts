// @vitest-environment happy-dom
/**
 * R65-53（十三轮批 E-5）回归：AnalysisPanel 失败提示同域守卫。
 * 60s 级 AI 调用失败时若作者已切档/切书，A 的失败 toast 不再弹在 B 的界面上
 * （成功路径早有双条件守卫，修复前 catch 路径裸弹）。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { nextTick, reactive } from 'vue'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

const mocks = vi.hoisted(() => {
  // 可切换 activeDocId（模拟 60s await 期间作者切档）
  const wsState = { activeDocId: 'doc_1' as string | null }
  return {
    autotag: vi.fn(),
    uiToast: vi.fn(),
    docEntry: { value: { path: '写作/正文/0001-a.md', content: 'x', dirty: false, baselineRevision: 'r0' } },
    wsState,
  }
})

vi.mock('../../../src/studio/web-next/src/api/analysis', () => ({
  autotag: mocks.autotag,
  inferMeta: vi.fn(async () => ({ 目标情绪: 'x' })),
  getAnalysisOverview: vi.fn(async () => ({ scoreTrend: [], allChapters: [] as string[] })),
}))
vi.mock('../../../src/studio/web-next/src/api/documents', () => ({
  updateDocMeta: vi.fn(async () => undefined),
}))
vi.mock('../../../src/studio/web-next/src/stores/doc', () => ({
  useDocStore: vi.fn(() => ({
    get: (id: string) => (id === 'doc_1' ? mocks.docEntry.value : undefined),
    refresh: vi.fn(async () => {}),
  })),
}))
vi.mock('../../../src/studio/web-next/src/stores/workspace', () => ({
  useWorkspaceStore: vi.fn(() => mocks.wsState),
}))
vi.mock('../../../src/studio/web-next/src/stores/tree', () => ({
  useTreeStore: vi.fn(() => ({
    byDocId: new Map([['doc_1', { path: '写作/正文/0001-a.md' }]]),
  })),
}))
vi.mock('../../../src/studio/web-next/src/stores/ui', () => ({
  useUiStore: vi.fn(() => ({ toast: mocks.uiToast })),
}))
vi.mock('lucide-vue-next', () => new Proxy({}, { get: () => ({ template: '<i/>' }) }))

import AnalysisPanel from '../../../src/studio/web-next/src/components/panels/AnalysisPanel.vue'

// wsState 换 reactive 实例：组件的 docId computed 依赖 activeDocId 的响应性——普通对象
// 切档不触发重算，守卫读到缓存旧值（mock 工厂闭包按调用时取值，此处置换时序安全）
mocks.wsState = reactive(mocks.wsState)

beforeEach(() => {
  setActivePinia(createPinia())
  mocks.autotag.mockReset()
  mocks.uiToast.mockClear()
  mocks.wsState.activeDocId = 'doc_1'
})

async function clickAnalyze(w: ReturnType<typeof mount>): Promise<void> {
  const btn = w.findAll('button').find((b) => b.text().includes('分析'))
  expect(btn).toBeDefined()
  await btn!.trigger('click')
}

describe('AnalysisPanel: 失败提示同域守卫（R65-53）', () => {
  it('失败时仍在原文档 → 弹错误提示（守卫不误伤正常路径）', async () => {
    mocks.autotag.mockRejectedValueOnce(new Error('AI 网关超时'))
    const w = mount(AnalysisPanel, { props: { bookName: '书A' } })
    await nextTick()
    await clickAnalyze(w)
    await flushPromises()
    expect(mocks.uiToast).toHaveBeenCalledTimes(1)
    expect(String(mocks.uiToast.mock.calls[0]![1])).toBe('error')
    w.unmount()
  })

  it('在途切档（activeDocId 变）后失败 → 不弹 A 的失败到 B 界面', async () => {
    let rejectA!: (e: Error) => void
    mocks.autotag.mockImplementationOnce(() => new Promise((_, rej) => { rejectA = rej }))
    const w = mount(AnalysisPanel, { props: { bookName: '书A' } })
    await nextTick()
    await clickAnalyze(w)
    mocks.wsState.activeDocId = 'doc_2' // await 期间切档
    await nextTick()
    rejectA(new Error('AI 网关超时'))
    await flushPromises()
    expect(mocks.uiToast).not.toHaveBeenCalled()
    w.unmount()
  })

  it('在途切书（bookName prop 变）后失败 → 不弹', async () => {
    let rejectA!: (e: Error) => void
    mocks.autotag.mockImplementationOnce(() => new Promise((_, rej) => { rejectA = rej }))
    const w = mount(AnalysisPanel, { props: { bookName: '书A' } })
    await nextTick()
    await clickAnalyze(w)
    await w.setProps({ bookName: '书B' }) // await 期间切书
    rejectA(new Error('AI 网关超时'))
    await flushPromises()
    expect(mocks.uiToast).not.toHaveBeenCalled()
    w.unmount()
  })
})
