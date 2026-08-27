// @vitest-environment happy-dom
/**
 * R65-56（十三轮批 E-8）回归：ChapterTreePanel 切书 watch 的 load 在途守卫。
 * A 书慢 load 落定时书名已换 B → 修复前仍走 ensureBaseline('A')——words store 的
 * reqGen 后调者胜使 A 反客为主，B 界面今日字数显示 A 的数据。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { nextTick, reactive, ref } from 'vue'

const mocks = vi.hoisted(() => ({
  /** tree.load 挂起队列：resolve(n) 放行第 n 个未决 load */
  pendingLoads: [] as Array<{ name: string; res: () => void }>,
  ensureBaseline: vi.fn(),
  resetInlineState: vi.fn(),
  dispatchCreate: vi.fn(),
}))
vi.mock('../../../src/studio/web-next/src/stores/tree', () => ({
  useTreeStore: vi.fn(() => ({
    loading: false,
    error: null,
    grouped: [],
    raw: [],
    load: (name: string) =>
      new Promise<void>((res) => {
        mocks.pendingLoads.push({ name, res })
      }),
  })),
}))
vi.mock('../../../src/studio/web-next/src/stores/words', () => ({
  useWordsStore: vi.fn(() => ({ ensureBaseline: mocks.ensureBaseline })),
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
vi.mock('../../../src/studio/web-next/src/stores/workspace', () => ({
  useWorkspaceStore: vi.fn(() => wsReactive),
}))
// 响应式 ws（模块级初始化——mock 工厂在 mount 时调用，取到 reactive 版）
const wsReactive = reactive(wsPlain)
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
  wsReactive.treeExpanded = []
  wsReactive.activeDocId = null
})

describe('ChapterTreePanel: 切书 load 在途守卫（R65-56）', () => {
  it('A 慢 load 落定时书名已换 B → 不再 ensureBaseline(A)/写 B 的展开态', async () => {
    const w = mount(ChapterTreePanel, { props: { bookName: '书A' } })
    expect(mocks.pendingLoads.map((p) => p.name)).toEqual(['书A']) // immediate 首跑挂起
    await w.setProps({ bookName: '书B' }) // 切书：B 的 load 入队
    expect(mocks.pendingLoads.map((p) => p.name)).toEqual(['书A', '书B'])

    // B 的 load 先落定（快），正常走完基线
    mocks.pendingLoads.find((p) => p.name === '书B')!.res()
    await flushPromises()
    expect(mocks.ensureBaseline).toHaveBeenCalledTimes(1)
    expect(mocks.ensureBaseline).toHaveBeenCalledWith('书B')

    // A 的慢 load 现在才落定——修复前 ensureBaseline('A') 会以 reqGen 后调者胜污染 B
    mocks.pendingLoads.find((p) => p.name === '书A')!.res()
    await flushPromises()
    expect(mocks.ensureBaseline).toHaveBeenCalledTimes(1) // 仍是 B，A 未反客为主
    w.unmount()
  })

  it('无切书（同书 load 落定）→ 基线正常登记', async () => {
    const w = mount(ChapterTreePanel, { props: { bookName: '书A' } })
    mocks.pendingLoads[0]!.res()
    await flushPromises()
    expect(mocks.ensureBaseline).toHaveBeenCalledWith('书A')
    w.unmount()
  })
})
