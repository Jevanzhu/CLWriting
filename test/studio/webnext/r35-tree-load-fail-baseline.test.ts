// @vitest-environment happy-dom
/**
 * R35-10（三十五轮）回归（面板面）：切书后新书树加载失败，ChapterTreePanel 短路——
 * tree.load 失败（error 非空）时跳过首开展开与 words.ensureBaseline。修复前 load 恒
 * resolve、只有书名守卫，ensureBaseline(新书) 照常发起，words 侧快照滞留旧书树 →
 * 带旧书总字数 POST 新书今日基线（污染服务端 words-diary）。
 * 手法对齐 chapter-tree-switch-guard.test.ts；words store 属主校验面见
 * r35-words-owner-baseline.test.ts。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { reactive, ref } from 'vue'

const mocks = vi.hoisted(() => ({
  /** tree.load 挂起队列：resolve(n) 放行第 n 个未决 load */
  pendingLoads: [] as Array<{ name: string; res: () => void }>,
  /** 这些书的 load 落定时置 error（模拟服务端重扫盘失败：catch 只置 error，raw 滞留） */
  failBooks: new Set<string>(),
  ensureBaseline: vi.fn(),
  resetInlineState: vi.fn(),
  dispatchCreate: vi.fn(),
}))
vi.mock('../../../src/studio/web-next/src/stores/tree', () => ({
  useTreeStore: vi.fn(() => {
    // load 闭包写回同一 store 对象的 error（真实 store：失败路径 error 非空、raw 不清）
    const store = {
      loading: false,
      error: null as string | null,
      grouped: [],
      raw: [],
      load: async (name: string) => {
        await new Promise<void>((res) => {
          mocks.pendingLoads.push({ name, res })
        })
        if (mocks.failBooks.has(name)) store.error = '章节树加载失败'
      },
    }
    return store
  }),
}))
vi.mock('../../../src/studio/web-next/src/stores/words', () => ({
  useWordsStore: vi.fn(() => ({ ensureBaseline: mocks.ensureBaseline, reset: vi.fn() })),
}))
vi.mock('../../../src/studio/web-next/src/stores/doc', () => ({
  useDocStore: vi.fn(() => ({ get: () => undefined, open: vi.fn() })),
}))
const wsPlain = {
  activeDocId: null as string | null,
  treeExpanded: [] as string[],
  openTab: vi.fn(),
  createTick: 0,
  createKind: 'chapter',
}
const wsReactive = reactive(wsPlain)
vi.mock('../../../src/studio/web-next/src/stores/workspace', () => ({
  useWorkspaceStore: vi.fn(() => wsReactive),
}))
vi.mock('../../../src/studio/web-next/src/composables/useNativeMenu', () => ({
  useNativeMenu: () => ({
    isNative: false,
    menuVisible: false,
    menuX: 0,
    menuY: 0,
    menuItems: [],
    popup: vi.fn(),
    onPopupSelect: vi.fn(),
    onPopupClose: vi.fn(),
  }),
}))
vi.mock('../../../src/studio/web-next/src/composables/useTreeMenu', () => ({
  useTreeMenu: () => ({ buildMenuItems: () => [], blankItems: [] }),
}))
vi.mock('../../../src/studio/web-next/src/composables/useChapterTreeActions', () => ({
  useChapterTreeActions: () => ({
    creating: ref(null),
    renamePath: ref(null),
    draggedPath: ref(null),
    metaEditing: ref(null),
    resetInlineState: mocks.resetInlineState,
    dispatchCreate: mocks.dispatchCreate,
    onMenuSelect: vi.fn(),
    onCreateCommit: vi.fn(),
    onCreateCancel: vi.fn(),
    onRenameCommit: vi.fn(),
    onRenameCancel: vi.fn(),
    onDrop: vi.fn(),
    onSaveMeta: vi.fn(),
  }),
}))
vi.mock('../../../src/studio/web-next/src/components/ui/ContextMenu.vue', () => ({ default: { template: '<div />' } }))
vi.mock('../../../src/studio/web-next/src/components/panels/ChapterTreeItem.vue', () => ({ default: { template: '<div />' } }))
vi.mock('../../../src/studio/web-next/src/components/panels/ChapterMetaDialog.vue', () => ({ default: { template: '<div />' } }))

import ChapterTreePanel from '../../../src/studio/web-next/src/components/panels/ChapterTreePanel.vue'

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  mocks.pendingLoads.length = 0
  mocks.failBooks.clear()
  wsReactive.treeExpanded = []
  wsReactive.activeDocId = null
})

describe('ChapterTreePanel: 新书 load 失败短路（R35-10）', () => {
  it('A→B 切书且 B load 失败 → 不发起 ensureBaseline(B)（无旧书总字数 POST 面污染）', async () => {
    const w = mount(ChapterTreePanel, { props: { bookName: '书A' } })
    expect(mocks.pendingLoads.map((p) => p.name)).toEqual(['书A'])
    mocks.pendingLoads[0]!.res()
    await flushPromises()
    expect(mocks.ensureBaseline).toHaveBeenCalledTimes(1)
    expect(mocks.ensureBaseline).toHaveBeenCalledWith('书A')

    // 切到 B，B 的 load 落定时置 error（真实 store：catch 只置 error，raw 滞留旧书树）
    mocks.failBooks.add('书B')
    await w.setProps({ bookName: '书B' })
    expect(mocks.pendingLoads.map((p) => p.name)).toEqual(['书A', '书B'])
    mocks.pendingLoads[1]!.res()
    await flushPromises()

    // 修复点：load 失败即短路——ensureBaseline(B) 不发起（不展开、不落基线）
    expect(mocks.ensureBaseline).toHaveBeenCalledTimes(1)
    w.unmount()
  })

  it('B load 成功 → 基线照常（短路不误伤正常路径）', async () => {
    const w = mount(ChapterTreePanel, { props: { bookName: '书A' } })
    mocks.pendingLoads[0]!.res()
    await flushPromises()
    await w.setProps({ bookName: '书B' })
    mocks.pendingLoads[1]!.res()
    await flushPromises()
    expect(mocks.ensureBaseline).toHaveBeenCalledTimes(2)
    expect(mocks.ensureBaseline).toHaveBeenLastCalledWith('书B')
    w.unmount()
  })
})
