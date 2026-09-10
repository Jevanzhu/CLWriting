// @vitest-environment happy-dom
/**
 * R1010c-FE1-P3-5（2026-09-10 全量独立复审修复批）：章节树 cap-hint 省略提示行右键死区。
 *
 * ChapterTreePanel.onBlankContextMenu 的守卫 `closest('.tree-item')` 会把 cap-hint 行
 * 一并吞掉——该行 class 同含 tree-item（ChapterTreeItem R54-G-1 提示行，复用行样式），
 * 右键它时节点菜单没有（非节点）、空白菜单也被守卫拦下，成双无死区。修法：守卫选择器
 * 排除 .tree-cap-hint，提示行右键落空白菜单；普通节点行守卫口径不变（仍不被空白覆盖）。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { reactive } from 'vue'

const holders = vi.hoisted(() => ({
  grouped: [] as unknown[],
  blankItems: [{ key: 'create-chapter', label: '新建章节' }],
  popup: vi.fn(),
}))

vi.mock('../../../src/studio/web-next/src/stores/tree', () => ({
  useTreeStore: () => ({
    loading: false,
    error: null,
    revision: '',
    issuePaths: new Set<string>(),
    grouped: holders.grouped,
    raw: holders.grouped,
    byPath: new Map(),
    byDocId: new Map(),
    load: vi.fn(async () => {}),
    clear: vi.fn(),
  }),
}))
vi.mock('../../../src/studio/web-next/src/stores/words', () => ({
  useWordsStore: () => ({ ensureBaseline: vi.fn(async () => {}), reset: vi.fn() }),
}))
vi.mock('../../../src/studio/web-next/src/stores/doc', () => ({
  useDocStore: () => ({ get: () => undefined, open: vi.fn() }),
}))
const wsPlain = {
  activeDocId: null as string | null,
  bookName: '书A',
  treeExpanded: [] as string[],
  openTab: vi.fn(),
  setTreeExpanded: vi.fn(),
  createTick: 0,
  createKind: 'chapter',
}
const wsReactive = reactive(wsPlain)
vi.mock('../../../src/studio/web-next/src/stores/workspace', () => ({
  useWorkspaceStore: () => wsReactive,
}))
vi.mock('../../../src/studio/web-next/src/composables/useNativeMenu', () => ({
  useNativeMenu: () => ({
    isNative: false,
    menuVisible: false,
    menuX: 0,
    menuY: 0,
    menuItems: [],
    popup: holders.popup,
    onPopupSelect: vi.fn(),
    onPopupClose: vi.fn(),
  }),
}))
vi.mock('../../../src/studio/web-next/src/composables/useTreeMenu', () => ({
  useTreeMenu: () => ({
    buildMenuItems: () => [{ key: 'rename', label: '重命名' }],
    blankItems: holders.blankItems,
  }),
}))
vi.mock('../../../src/studio/web-next/src/composables/useChapterTreeActions', () => ({
  useChapterTreeActions: () => ({
    creating: { value: null },
    renamePath: { value: null },
    draggedPath: { value: null },
    metaEditing: { value: null },
    resetInlineState: vi.fn(),
    dispatchCreate: vi.fn(),
    onMenuSelect: vi.fn(),
    onCreateCommit: vi.fn(),
    onCreateCancel: vi.fn(),
    onRenameCommit: vi.fn(),
    onRenameCancel: vi.fn(),
    onDrop: vi.fn(),
    onSaveMeta: vi.fn(),
  }),
}))
vi.mock('../../../src/studio/web-next/src/components/ui/ContextMenu.vue', () => ({
  default: { template: '<div />' },
}))
vi.mock('../../../src/studio/web-next/src/components/panels/ChapterMetaDialog.vue', () => ({
  default: { template: '<div />' },
}))

import ChapterTreePanel from '../../../src/studio/web-next/src/components/panels/ChapterTreePanel.vue'
import type { TreeNode } from '../../../src/studio/web-next/src/types/tree'

/** 101 章目录：展开后子项超 RENDER_CAP=100，尾部出现 cap-hint 行 */
function bodyDir(n: number): TreeNode {
  return {
    path: '写作/正文',
    name: '正文',
    isDirectory: true,
    role: 'group',
    children: Array.from({ length: n }, (_, i) => {
      const padded = String(i + 1).padStart(4, '0')
      return {
        path: `写作/正文/${padded}-第${i + 1}章.md`,
        name: `${padded}-第${i + 1}章.md`,
        isDirectory: false,
        role: 'chapter',
        children: [],
        docId: `doc_${i + 1}`,
        status: 'draft',
      }
    }),
  }
}

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  // per-book 首开标记走 stub 存储——每个用例都是「首开」→ defaultExpandedDirs 套默认展开
  const ls = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => ls.get(k) ?? null,
    setItem: (k: string, v: string) => void ls.set(k, v),
    removeItem: (k: string) => void ls.delete(k),
  })
  wsReactive.treeExpanded = []
  wsReactive.activeDocId = null
  holders.grouped = [bodyDir(101)]
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('R1010c-FE1-P3-5: cap-hint 行右键不再死区', () => {
  it('右键 cap-hint 省略提示行 → 弹空白菜单（修复前被 closest(.tree-item) 吞掉零菜单）', async () => {
    const w = mount(ChapterTreePanel, { props: { bookName: '书A' } })
    await flushPromises()
    const hint = w.find('.tree-cap-hint')
    expect(hint.exists()).toBe(true) // 101 子项 → 提示行在渲染面

    await hint.trigger('contextmenu')
    expect(holders.popup).toHaveBeenCalledTimes(1)
    expect(holders.popup.mock.calls[0]![0]).toBe(holders.blankItems) // 空白菜单（非节点菜单）
    w.unmount()
  })

  it('普通节点行守卫口径不变：右键行仍弹节点菜单、不被空白菜单覆盖', async () => {
    const w = mount(ChapterTreePanel, { props: { bookName: '书A' } })
    await flushPromises()
    await w.find('.tree-item[data-path="写作/正文"]').trigger('contextmenu')
    // 节点 handler 弹节点菜单一次；冒泡到根的空白 handler 被守卫拦下（不二次弹空白）
    expect(holders.popup).toHaveBeenCalledTimes(1)
    expect(holders.popup.mock.calls[0]![0]).not.toBe(holders.blankItems)
    w.unmount()
  })

  it('树空白处右键 → 仍弹空白菜单（守卫不误伤原空白路径）', async () => {
    const w = mount(ChapterTreePanel, { props: { bookName: '书A' } })
    await flushPromises()
    await w.find('.tree-list').trigger('contextmenu')
    expect(holders.popup).toHaveBeenCalledTimes(1)
    expect(holders.popup.mock.calls[0]![0]).toBe(holders.blankItems)
    w.unmount()
  })
})
