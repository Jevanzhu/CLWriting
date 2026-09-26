// @vitest-environment happy-dom
/**
 * AnalysisPanel 分析期间正文保护行为（happy-dom）。
 * （原 z-frontend-regressions 的 Z-2 节，按行为单拆。）
 *
 * Z-2（第五十八轮 Z 系列）：分析期间的用户键入不再被 T0 旧正文回拼覆盖——analyzeTags
 * 走 refresh（dirty 分支承担正文保护），不再调用 patch 回拼本地正文。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { ref } from 'vue'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

vi.mock('../../../src/studio/web-next/src/api/analysis', () => ({
  autotag: vi.fn(async () => ({ 钩子类型: '悬念钩' })),
  inferMeta: vi.fn(async () => ({ 目标情绪: '压抑到释然' })),
}))
vi.mock('../../../src/studio/web-next/src/api/documents', () => ({
  updateDocMeta: vi.fn(async () => undefined),
}))
const docEntryRef = ref<{ path: string; content: string; dirty: boolean; baselineRevision: string } | undefined>(
  undefined,
)
const docPatchMock = vi.fn()
const docRefreshMock = vi.fn(async () => {})
vi.mock('../../../src/studio/web-next/src/stores/doc', () => ({
  useDocStore: vi.fn(() => ({
    get: (id: string) => (id === 'doc_1' ? docEntryRef.value : undefined),
    patch: docPatchMock,
    refresh: docRefreshMock,
    save: vi.fn(async () => true),
  })),
}))
vi.mock('../../../src/studio/web-next/src/stores/workspace', () => ({
  useWorkspaceStore: vi.fn(() => ({ activeDocId: 'doc_1', openTab: vi.fn() })),
}))
vi.mock('../../../src/studio/web-next/src/stores/tree', () => ({
  useTreeStore: vi.fn(() => ({
    byDocId: new Map([['doc_1', { path: '写作/正文/0001-a.md' }]]),
  })),
}))
const uiToastMock = vi.fn()
vi.mock('../../../src/studio/web-next/src/stores/ui', () => ({
  useUiStore: vi.fn(() => ({ toast: uiToastMock })),
}))
vi.mock('lucide-vue-next', () => new Proxy({}, { get: () => ({ template: '<i/>' }) }))

import AnalysisPanel from '../../../src/studio/web-next/src/components/panels/AnalysisPanel.vue'

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
})

describe('Z-2: 分析期间键入不被旧正文回拼覆盖', () => {
  it('analyzeTags：refresh 被调、patch 不被调（无 T0 回拼）', async () => {
    docEntryRef.value = {
      path: '写作/正文/0001-a.md',
      content: '---\n章号: 1\n标题: 开篇\n钩子类型: 悬念钩\n钩子强弱: 中\n情绪定位: 铺垫\n---\n\n新键入的内容',
      dirty: true,
      baselineRevision: 'r0',
    }
    const w = mount(AnalysisPanel, { props: { bookName: '书A' } })
    await flushPromises()
    // 点「分析标签」按钮（带 loading 态的那个）
    const btn = w.findAll('button').find((b) => b.text().includes('分析'))
    expect(btn).toBeDefined()
    await btn!.trigger('click')
    await flushPromises()
    expect(docRefreshMock).toHaveBeenCalledWith('doc_1')
    // 修复点：不再有「本地正文拼回」的 patch（此前 T0 快照覆盖用户键入）
    expect(docPatchMock).not.toHaveBeenCalled()
    w.unmount()
  })
})
