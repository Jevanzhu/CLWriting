// @vitest-environment happy-dom
/**
 * R30-7（三十轮）回归——版本恢复后按 doc.refresh 返回值分流 toast。
 *
 * 缺陷：refresh 内部 catch{} 静默吞错（best-effort 对齐磁盘），网络抖动时恢复已落盘
 * 但编辑器未对齐，HistoryPanel 仍 toast「已恢复」假成功——编辑器显旧正文、基线未推进，
 * 下次编辑撞 REVISION_CONFLICT 才暴露。修复：refresh 补返回值 Promise<boolean>（纯增量，
 * 既有调用方忽略返回值零影响），恢复流程 true → success toast；false → warning toast
 * 「恢复已落盘但编辑器未对齐，请手动重载」。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { ref } from 'vue'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

const SNAP = { id: 'snap-1', time: Date.now() - 60_000, origin: 'manual', words: 100, pinned: false }
vi.mock('../../../src/studio/web-next/src/api/snapshots', () => ({
  listSnapshots: vi.fn(async () => [SNAP]),
  restoreSnapshot: vi.fn(async () => undefined),
}))
// doc mock 单例（照 history-restore-dirty 范型：工厂每调返回同一组 spy）
const docEntryRef = ref<{ path: string; content: string; dirty: boolean; baselineRevision: string; saving?: boolean } | undefined>(undefined)
const docSaveMock = vi.fn(async () => true)
const docRefreshMock = vi.fn(async (): Promise<boolean> => true)
vi.mock('../../../src/studio/web-next/src/stores/doc', () => ({
  useDocStore: vi.fn(() => ({
    get: (id: string) => (id === 'doc_1' ? docEntryRef.value : undefined),
    save: docSaveMock,
    refresh: docRefreshMock, // R30-7 观察口：组件按其返回值分流 toast
  })),
  __setEntry: (e: typeof docEntryRef.value) => { docEntryRef.value = e },
}))
vi.mock('../../../src/studio/web-next/src/stores/workspace', () => ({
  useWorkspaceStore: vi.fn(() => ({ activeDocId: 'doc_1', openTab: vi.fn() })),
}))
const uiAskMock = vi.fn(async () => true)
const uiToastMock = vi.fn()
vi.mock('../../../src/studio/web-next/src/stores/ui', () => ({
  useUiStore: vi.fn(() => ({ ask: uiAskMock, toast: uiToastMock })),
}))

async function mountAndRestore(): Promise<ReturnType<typeof mount>> {
  const { default: HistoryPanel } = await import('../../../src/studio/web-next/src/components/panels/HistoryPanel.vue')
  const wrapper = mount(HistoryPanel, { props: { bookName: '书A' } })
  await flushPromises()
  await wrapper.find('.restore-btn').trigger('click')
  await flushPromises()
  return wrapper
}

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  docEntryRef.value = {
    path: '写作/正文/0001-开篇.md',
    content: '当前正文',
    dirty: false,
    baselineRevision: 'rev-0',
  }
})

describe('R30-7: 恢复 toast 按 refresh 返回值分流', () => {
  it('refresh 失败（false）→ warning toast（不再假报 success）', async () => {
    docRefreshMock.mockResolvedValueOnce(false)
    const wrapper = await mountAndRestore()
    expect(uiToastMock).toHaveBeenCalledTimes(1)
    const [msg, kind] = uiToastMock.mock.calls[0]!
    expect(kind).toBe('warning')
    expect(String(msg)).toContain('已恢复')
    expect(String(msg)).toContain('手动重载')
    // 分流前提：refresh 确实被走到
    expect(docRefreshMock).toHaveBeenCalledWith('doc_1')
    wrapper.unmount()
  })

  it('refresh 成功（true）→ success toast（成功路径不回归）', async () => {
    const wrapper = await mountAndRestore()
    expect(uiToastMock).toHaveBeenCalledTimes(1)
    expect(uiToastMock).toHaveBeenCalledWith(expect.stringContaining('已恢复到'), 'success')
    wrapper.unmount()
  })

  it('warning 分支不再出现 success 字样（二选一分流，不叠加）', async () => {
    docRefreshMock.mockResolvedValue(false)
    const wrapper = await mountAndRestore()
    const kinds = uiToastMock.mock.calls.map((c) => c[1])
    expect(kinds).toEqual(['warning'])
    wrapper.unmount()
  })
})
