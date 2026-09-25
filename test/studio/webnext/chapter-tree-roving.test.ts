// @vitest-environment happy-dom
/**
 * R1010-P3（G6-②/G6-③）回归：章节树目录拖拽反馈 + 树键盘 roving。
 *
 * G6-②：目录行 draggable 但 moveDoc 仅 docId 面——修复前 onDrop 对无 docId 源
 * 静默 return（拖目录落下无任何反馈，近似「卡死」）；修复后补 info toast 明示
 * 「目录暂不支持拖拽移动」，移动语义不变（章节拖拽照常走 doMove）。
 * G6-③：100 行树原 100 个 Tab 停靠点（每行 role=button tabindex=0）——修复后
 * role=tree/treeitem/group + roving tabindex（唯 tabstop 行 0 其余 -1）+ 方向键
 * 导航（↑↓ 平移 / → 展开或进子 / ← 收起或回父 / Home/End 首末，IME 组合期让渡）。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { ref } from 'vue'
import { mount } from '@vue/test-utils'

// ── G6-② composable 侧：沿用 chapter-tree-actions-y8-y29 的 store mock 搭法 ──
vi.mock('../../../src/studio/web-next/src/api/documents', () => ({
  createDoc: vi.fn(),
  renameDoc: vi.fn(),
  moveDoc: vi.fn(),
  copyDoc: vi.fn(),
  deleteDoc: vi.fn(),
  updateChapterMetaDoc: vi.fn(),
  batchFinalizeDocs: vi.fn(),
}))
const treeMock = {
  byPath: new Map<string, { docId?: string }>(),
  byDocId: new Map<string, { path: string }>(),
  load: vi.fn(async () => {}),
  updateWordCount: vi.fn(),
  // G6-③ 组件侧消费（红点集合）
  issuePaths: new Set<string>(),
}
const toastMock = vi.fn()
vi.mock('../../../src/studio/web-next/src/stores/ui', () => ({
  useUiStore: vi.fn(() => ({ toast: toastMock, ask: vi.fn(async () => true) })),
}))
vi.mock('../../../src/studio/web-next/src/stores/workspace', () => ({
  useWorkspaceStore: vi.fn(() => ({ openTab: vi.fn(), activeDocId: ref(null) })),
}))
vi.mock('../../../src/studio/web-next/src/stores/tree', () => ({
  useTreeStore: vi.fn(() => treeMock),
}))
vi.mock('../../../src/studio/web-next/src/stores/doc', () => ({
  useDocStore: vi.fn(() => ({
    get: vi.fn(() => undefined),
    open: vi.fn(),
    refresh: vi.fn(async () => {}),
    save: vi.fn(async () => true),
    patch: vi.fn(),
    discard: vi.fn(),
    clearDirtyMirror: vi.fn(),
  })),
}))
import { moveDoc } from '../../../src/studio/web-next/src/api/documents'
import { useChapterTreeActions } from '../../../src/studio/web-next/src/composables/useChapterTreeActions'

describe('R1010-P3 G6-②：目录拖拽落下 toast 明示（不再静默丢弃）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    treeMock.byPath.clear()
  })

  it('拖目录（无 docId 源）→ info toast + 不触发 moveDoc', async () => {
    treeMock.byPath.set('写作/正文/第一卷', { })
    const actions = useChapterTreeActions({ bookName: () => '书', openError: ref(null) })
    actions.draggedPath.value = '写作/正文/第一卷'
    await actions.onDrop('写作/正文/第二卷')
    expect(toastMock).toHaveBeenCalledTimes(1)
    expect(toastMock).toHaveBeenCalledWith('目录暂不支持拖拽移动（可拖拽章节到目标目录）', 'info')
    expect(moveDoc).not.toHaveBeenCalled()
  })

  it('拖章节（docId 源）→ 照常 doMove，无 toast', async () => {
    treeMock.byPath.set('写作/正文/0001-开篇.md', { docId: 'd1' })
    const actions = useChapterTreeActions({ bookName: () => '书', openError: ref(null) })
    actions.draggedPath.value = '写作/正文/0001-开篇.md'
    await actions.onDrop('写作/正文/第二卷')
    expect(toastMock).not.toHaveBeenCalled()
    expect(moveDoc).toHaveBeenCalledWith('书', 'd1', '写作/正文/第二卷')
  })
})

// ── G6-③ 组件侧：role 契约 + roving tabindex + 方向键真焦点导航 ──
// （tree store 复用上方同一 mock：byPath/byDocId 供 composable、issuePaths 供组件）
import ChapterTreeItem from '../../../src/studio/web-next/src/components/panels/ChapterTreeItem.vue'
import type { TreeNode } from '../../../src/studio/web-next/src/types/tree'

const ch1: TreeNode = {
  path: '写作/正文/0001-开篇.md', name: '0001-开篇.md', isDirectory: false,
  role: 'chapter', children: [], status: 'draft', docId: 'd1',
}
const vol2: TreeNode = {
  path: '写作/正文/第二卷', name: '第二卷', isDirectory: true, role: 'group',
  children: [], status: 'draft',
}
const ch3: TreeNode = {
  path: '写作/正文/第二卷/0003-风暴.md', name: '0003-风暴.md', isDirectory: false,
  role: 'chapter', children: [], status: 'draft', docId: 'd3',
}
vol2.children = [ch3]
const bodyRoot: TreeNode = {
  path: '写作/正文', name: '正文', isDirectory: true, role: 'group',
  children: [ch1, vol2], status: 'draft',
}

/** 挂载在带 role=tree 的宿主 div 下（onTreeKeyDown 经 closest 找树根） */
function mountTree(tabstopPath: string | null = '写作/正文/0001-开篇.md') {
  const host = document.createElement('div')
  host.setAttribute('role', 'tree')
  document.body.appendChild(host)
  const wrapper = mount(ChapterTreeItem, {
    props: {
      node: bodyRoot,
      depth: 0,
      // 两级均展开：ch1 → 第二卷（展开）→ ch3 为完整可见序
      expanded: new Set(['写作/正文', '写作/正文/第二卷']),
      activePath: '写作/正文/0001-开篇.md',
      tabstopPath,
      creatingDirPath: null,
      creatingKind: null,
      creatingSeed: '',
      renamePath: null,
      draggedPath: null,
    },
    attachTo: host,
  })
  return { wrapper, host }
}

function row(wrapper: { element: Element }, path: string): HTMLElement {
  // 注：本文件归项目根 tsconfig——.vue 导入解析为 any，querySelector 上不可带类型参
  // 数（TS2347）；经本具型入口收敛（Element.querySelector 本就返回 HTMLElement |
  // null，判空收窄即可）。
  const el = wrapper.element.querySelector(`[data-path="${path}"]`)
  if (!(el instanceof HTMLElement)) throw new Error(`行未渲染：${path}`)
  return el
}

describe('R1010-P3 G6-③：树 roving tabindex + 方向键导航', () => {
  it('role 契约：行 treeitem + 目录 aria-expanded/level + 子树 group + 唯一 Tab 停靠', () => {
    const { wrapper } = mountTree()
    const r = row(wrapper, '写作/正文')
    expect(r.getAttribute('role')).toBe('treeitem')
    expect(r.getAttribute('aria-expanded')).toBe('true')
    expect(r.getAttribute('aria-level')).toBe('1')
    // roving：tabstop 章 0，其余（目录/别章）-1
    expect(row(wrapper, '写作/正文/0001-开篇.md').tabIndex).toBe(0)
    expect(row(wrapper, '写作/正文').tabIndex).toBe(-1)
    expect(row(wrapper, '写作/正文/第二卷').tabIndex).toBe(-1)
    expect(row(wrapper, '写作/正文/第二卷/0003-风暴.md').tabIndex).toBe(-1)
    // 章 aria-selected + 子树 group 语义容器
    expect(row(wrapper, '写作/正文/0001-开篇.md').getAttribute('aria-selected')).toBe('true')
    const groups = wrapper.element.querySelectorAll('[role="group"]')
    expect(groups.length).toBeGreaterThanOrEqual(1)
    wrapper.unmount()
  })

  it('↑↓ 在可见行间移动真焦点（DOM 序）', () => {
    const { wrapper } = mountTree()
    const first = row(wrapper, '写作/正文/0001-开篇.md')
    first.focus()
    expect(document.activeElement).toBe(first)
    first.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
    expect(document.activeElement).toBe(row(wrapper, '写作/正文/第二卷'))
    // 再 ↓ 进第二卷首章（第二卷空时下一可见行 = 其子章 ch3？——第二卷 children=[ch3]）
    row(wrapper, '写作/正文/第二卷').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
    expect(document.activeElement).toBe(row(wrapper, '写作/正文/第二卷/0003-风暴.md'))
    // ↑ 回第二卷
    row(wrapper, '写作/正文/第二卷/0003-风暴.md').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }))
    expect(document.activeElement).toBe(row(wrapper, '写作/正文/第二卷'))
    wrapper.unmount()
  })

  it('← 在章行回焦点到父目录行；→ 在已展开目录进首子行', () => {
    const { wrapper } = mountTree()
    const deep = row(wrapper, '写作/正文/第二卷/0003-风暴.md')
    deep.focus()
    deep.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }))
    expect(document.activeElement).toBe(row(wrapper, '写作/正文/第二卷'))
    // → 在已展开目录 = 进首个子行
    row(wrapper, '写作/正文/第二卷').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
    expect(document.activeElement).toBe(row(wrapper, '写作/正文/第二卷/0003-风暴.md'))
    // ← 在已展开目录 = 收起（emit toggle）
    const vol = row(wrapper, '写作/正文/第二卷')
    const before = wrapper.emitted('toggle')
    vol.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }))
    const after = wrapper.emitted('toggle')
    expect(after?.length).toBe((before?.length ?? 0) + 1)
    expect(after!.at(-1)).toEqual(['写作/正文/第二卷'])
    wrapper.unmount()
  })

  it('Home/End 跳首/末可见行', () => {
    const { wrapper } = mountTree()
    const first = row(wrapper, '写作/正文')
    const last = row(wrapper, '写作/正文/第二卷/0003-风暴.md')
    first.focus()
    first.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }))
    expect(document.activeElement).toBe(last)
    last.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }))
    expect(document.activeElement).toBe(first)
    wrapper.unmount()
  })

  it('→ 在折叠目录 emit toggle（展开）而非移焦', async () => {
    // 折叠第二卷：expanded 只含父
    const host = document.createElement('div')
    host.setAttribute('role', 'tree')
    document.body.appendChild(host)
    const wrapper = mount(ChapterTreeItem, {
      props: {
        node: bodyRoot,
        depth: 0,
        expanded: new Set(['写作/正文']),
        activePath: null,
        tabstopPath: '写作/正文',
        creatingDirPath: null,
        creatingKind: null,
        creatingSeed: '',
        renamePath: null,
        draggedPath: null,
      },
      attachTo: host,
    })
    // 折叠目录的子行不在 DOM（可见序排除）
    expect(wrapper.element.querySelector('[data-path="写作/正文/第二卷/0003-风暴.md"]')).toBeNull()
    const vol = row(wrapper, '写作/正文/第二卷')
    vol.focus()
    vol.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
    expect(wrapper.emitted('toggle')?.at(-1)).toEqual(['写作/正文/第二卷'])
    wrapper.unmount()
  })
})
