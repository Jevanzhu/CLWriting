// @vitest-environment happy-dom
/**
 * R29 二十九轮批 E 前端回归（E-2 / E-7 组件面）。
 *
 * E-2：`await doc.open(node)` 后 openTab 缺切书复检——SearchPanel.open 与
 * ChapterTreePanel.onSelect 在 await 前快照 ws.bookName，await 后不一致则跳过
 * openTab（旧书 docId 不开进新书工作区）。
 *
 * E-7：脏路由 name='' 不清数据——ChapterTreePanel 的 `!name` 分支清 tree/红点/今日
 * 字数展示态；Book.vue 对 name='' 先 flushDirty 落盘残存 dirty 再按切换口径清各 store。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

const mocks = vi.hoisted(() => ({
  search: vi.fn(),
  getContent: vi.fn<() => Promise<string>>(async () => '内容'),
  saveContent: vi.fn(),
  getTree: vi.fn(),
  getTreeIssues: vi.fn(async () => ({ issues: {}, warning: null })),
  getWordsDiary: vi.fn(async () => {
    const d = new Date()
    const m = String(d.getMonth() + 1).padStart(2, '0')
    const day = String(d.getDate()).padStart(2, '0')
    return { date: `${d.getFullYear()}-${m}-${day}`, baseline: 100, delta: null }
  }),
  postBaseline: vi.fn(async () => {}),
  getBookPrefs: vi.fn(async () => ({})),
  putBookPrefs: vi.fn(async () => {}),
}))
vi.mock('../../../src/studio/web-next/src/api/search', () => ({ search: mocks.search }))
vi.mock('../../../src/studio/web-next/src/api/documents', () => ({
  getContent: mocks.getContent,
  saveContent: mocks.saveContent,
  finalizeDoc: vi.fn(),
}))
vi.mock('../../../src/studio/web-next/src/api/books', () => ({
  getTree: mocks.getTree,
  getWordsDiary: mocks.getWordsDiary,
  postBaseline: mocks.postBaseline,
}))
vi.mock('../../../src/studio/web-next/src/api/tree-issues', () => ({
  getTreeIssues: mocks.getTreeIssues,
}))
vi.mock('../../../src/studio/web-next/src/api/prefs', () => ({
  getBookPrefs: mocks.getBookPrefs,
  putBookPrefs: mocks.putBookPrefs,
}))
vi.mock('../../../src/studio/web-next/src/api/client', () => ({
  ApiError: class ApiError extends Error {
    status = 0
    code?: string
  },
  getToken: vi.fn(() => 'test-token'),
  rebootstrap: vi.fn(async () => {}),
}))

// ── SearchPanel ──────────────────────────────────────────────
import SearchPanel from '../../../src/studio/web-next/src/components/panels/SearchPanel.vue'
import { useTreeStore } from '../../../src/studio/web-next/src/stores/tree'
import { useWorkspaceStore } from '../../../src/studio/web-next/src/stores/workspace'
import type { TreeNode } from '../../../src/studio/web-next/src/types/tree'

function makeNode(docId: string): TreeNode {
  return {
    path: `写作/正文/${docId}.md`,
    name: `${docId}.md`,
    isDirectory: false,
    role: 'chapter',
    docId,
    children: [],
  } as TreeNode
}

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  mocks.getTree.mockResolvedValue({ nodes: [makeNode('d1')], revision: 'r1' })
  mocks.getContent.mockResolvedValue('内容')
  mocks.saveContent.mockResolvedValue({ ok: true, revision: 'sha256:x' })
})

describe('E-2: SearchPanel.open 在途切书 → 跳过 openTab', () => {
  it('doc.open 在途切书 → 迟到的打开不把旧书文档开进新书', async () => {
    const tree = useTreeStore()
    const ws = useWorkspaceStore()
    ws.setBook('书A')
    tree.raw = [makeNode('d1')] // 直接播种树索引（byPath 派生）
    let release!: (v: string) => void
    mocks.getContent.mockImplementationOnce(() => new Promise<string>((r) => { release = r }))

    const w = mount(SearchPanel, { props: { bookName: '书A' } })
    mocks.search.mockResolvedValue({
      results: [{ path: '写作/正文/d1.md', matches: [{ line: 1, text: '命中' }] }],
      truncated: false,
    })
    await w.find('input').setValue('命中')
    await w.find('input').trigger('keydown.enter')
    await flushPromises()
    const openTabSpy = vi.spyOn(ws, 'openTab')

    await w.find('.result').trigger('click') // open() 挂在 getContent 上
    ws.setBook('书B') // await 窗口内切书
    release('内容')
    await flushPromises()

    expect(openTabSpy).not.toHaveBeenCalled() // 修复点：书名复检不过 → 不 openTab
    expect(ws.activeDocId).toBeNull()
    w.unmount()
  })

  it('未切书 → 打开照常（守卫不误伤）', async () => {
    const tree = useTreeStore()
    const ws = useWorkspaceStore()
    ws.setBook('书A')
    tree.raw = [makeNode('d1')]
    mocks.search.mockResolvedValue({
      results: [{ path: '写作/正文/d1.md', matches: [{ line: 1, text: '命中' }] }],
      truncated: false,
    })
    const w = mount(SearchPanel, { props: { bookName: '书A' } })
    await w.find('input').setValue('命中')
    await w.find('input').trigger('keydown.enter')
    await flushPromises()
    await w.find('.result').trigger('click')
    // 两轮泵：doc.open 链上有 crypto.subtle.digest（宿主异步边界），单轮 flushPromises 不够
    await flushPromises()
    await flushPromises()
    expect(ws.activeDocId).toBe('d1')
    w.unmount()
  })
})

// ── ChapterTreePanel（E-2 onSelect + E-7 !name 清态）────────────────
// 组合件 mock 沿 chapter-tree-switch-guard 先例；store 用真实实例
const actionsMock = vi.hoisted(() => ({
  resetInlineState: vi.fn(),
  creating: { value: null },
  renamePath: { value: null },
  draggedPath: { value: null },
  metaEditing: { value: null },
  onMenuSelect: vi.fn(),
  onCreateCommit: vi.fn(),
  onCreateCancel: vi.fn(),
  onRenameCommit: vi.fn(),
  onRenameCancel: vi.fn(),
  onDrop: vi.fn(),
  onSaveMeta: vi.fn(),
  dispatchCreate: vi.fn(),
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
  useChapterTreeActions: () => actionsMock,
}))
vi.mock('../../../src/studio/web-next/src/components/ui/ContextMenu.vue', () => ({ default: { template: '<div />' } }))
// 节点桩：点击即以本节点 emit select（驱动 onSelect）
vi.mock('../../../src/studio/web-next/src/components/panels/ChapterTreeItem.vue', () => ({
  default: {
    props: ['node'],
    template: '<button class="ci" @click="$emit(\'select\', node)"></button>',
  },
}))
vi.mock('../../../src/studio/web-next/src/components/panels/ChapterMetaDialog.vue', () => ({ default: { template: '<div />' } }))

import ChapterTreePanel from '../../../src/studio/web-next/src/components/panels/ChapterTreePanel.vue'
import { useDocStore } from '../../../src/studio/web-next/src/stores/doc'
import { useWordsStore } from '../../../src/studio/web-next/src/stores/words'

describe('E-2: ChapterTreePanel.onSelect 在途切书 → 跳过 openTab', () => {
  it('doc.open 在途切书 → 不把旧书 docId 开进新书工作区', async () => {
    const ws = useWorkspaceStore()
    ws.setBook('书A')
    let release!: (v: string) => void
    mocks.getContent.mockImplementationOnce(() => new Promise<string>((r) => { release = r }))

    const w = mount(ChapterTreePanel, { props: { bookName: '书A' } })
    await flushPromises() // immediate watch → tree.load('书A') 落定，节点渲染
    expect(w.findAll('.ci').length).toBe(1)

    await w.find('.ci').trigger('click') // onSelect → doc.open 挂起
    ws.setBook('书B') // await 窗口内切书
    release('内容')
    await flushPromises()

    expect(ws.activeDocId).toBeNull() // 修复点：书名复检不过 → 不 openTab
    w.unmount()
  })
})

describe('E-7: ChapterTreePanel 脏路由 name=\'\' → 清树/红点/今日字数展示态', () => {
  it('bookName 变 \'\' → tree.raw/issues 清空、words 展示态复位', async () => {
    const ws = useWorkspaceStore()
    ws.setBook('书A')
    mocks.getTreeIssues.mockResolvedValue({ issues: { d1: { red: 1 } }, warning: null })
    const tree = useTreeStore()
    const words = useWordsStore()
    const w = mount(ChapterTreePanel, { props: { bookName: '书A' } })
    await flushPromises()
    expect(tree.raw.length).toBe(1)
    expect(Object.keys(tree.issues).length).toBe(1)
    // 预置前书今日字数展示态
    words.date = '2026-01-01'
    words.baseline = 50
    words.todayDelta = 5
    words.ready = true

    await w.setProps({ bookName: '' }) // 脏路由：name=''
    await flushPromises()

    expect(tree.raw).toEqual([]) // 修复点：前书树不再滞留展示
    expect(tree.issues).toEqual({})
    expect(words.date).toBeNull()
    expect(words.todayDelta).toBeNull()
    expect(words.ready).toBe(false)
    w.unmount()
  })

  it('在途 tree.load 落定于清态之后 → 不回填旧书树（clear 推代）', async () => {
    const ws = useWorkspaceStore()
    ws.setBook('书A')
    let releaseTree!: (v: { nodes: TreeNode[]; revision: string }) => void
    mocks.getTree.mockImplementationOnce(
      () => new Promise((r) => { releaseTree = r }),
    )
    const tree = useTreeStore()
    const w = mount(ChapterTreePanel, { props: { bookName: '书A' } })
    await flushPromises()
    expect(tree.loading).toBe(true) // A 的 load 挂起

    await w.setProps({ bookName: '' })
    expect(tree.raw).toEqual([])
    releaseTree({ nodes: [makeNode('late')], revision: 'rX' })
    await flushPromises()

    expect(tree.raw).toEqual([]) // 修复点：迟到响应不回填（loadGen 被 clear 推代）
    w.unmount()
  })
})

// ── Book.vue 脏路由分支（E-7）───────────────────────────────
// 脚手架沿 book-watch-reentry：视图全 stub + useSse mock（resync 断言不在本文件范围）
const stub = vi.hoisted(() => ({ template: '<div />' }))
vi.mock('../../../src/studio/web-next/src/components/shell/WorkspaceShell.vue', () => ({ default: stub }))
vi.mock('../../../src/studio/web-next/src/views/EditorView.vue', () => ({ default: stub }))
vi.mock('../../../src/studio/web-next/src/views/WorkbenchView.vue', () => ({ default: stub }))
vi.mock('../../../src/studio/web-next/src/views/OnboardView.vue', () => ({ default: stub }))
vi.mock('../../../src/studio/web-next/src/views/OverviewView.vue', () => ({ default: stub }))
vi.mock('../../../src/studio/web-next/src/views/RelationsView.vue', () => ({ default: stub }))
vi.mock('../../../src/studio/web-next/src/views/LearnView.vue', () => ({ default: stub }))
vi.mock('../../../src/studio/web-next/src/views/StyleView.vue', () => ({ default: stub }))
vi.mock('../../../src/studio/web-next/src/views/AuditView.vue', () => ({ default: stub }))
vi.mock('../../../src/studio/web-next/src/composables/useHeartbeat', () => ({ useHeartbeat: vi.fn() }))
vi.mock('../../../src/studio/web-next/src/composables/useSse', () => ({
  useSse: vi.fn(() => ({ resync: vi.fn() })),
}))
vi.mock('../../../src/studio/web-next/src/composables/useChatTier', () => ({
  useChatTier: vi.fn(() => ({ refresh: vi.fn() })),
}))
const routeHolder = vi.hoisted(() => ({ route: null as { params: { name: string } } | null }))
const routerMock = vi.hoisted(() => ({ replace: vi.fn() }))
vi.mock('vue-router', async () => {
  const { reactive } = await import('vue')
  routeHolder.route = reactive({ params: { name: '书A' } })
  return { useRoute: () => routeHolder.route, useRouter: () => routerMock }
})
vi.mock('../../../src/studio/web-next/node_modules/vue-router', async () => {
  const { reactive } = await import('vue')
  routeHolder.route = routeHolder.route ?? reactive({ params: { name: '书A' } })
  return { useRoute: () => routeHolder.route, useRouter: () => routerMock }
})

import Book from '../../../src/studio/web-next/src/pages/Book.vue'
import { useWorkbenchStore } from '../../../src/studio/web-next/src/stores/workbench'
import { useCheckStore } from '../../../src/studio/web-next/src/stores/check'
import { useUiStore } from '../../../src/studio/web-next/src/stores/ui'

describe('E-7: Book.vue 脏路由 name=\'\' → 先落盘 dirty 再清各 store', () => {
  it('name=\'\' → flushDirty 落盘 + doc/工作台/各 store 清空，不弹切书确认', async () => {
    const w = mount(Book)
    await flushPromises()

    // 前书留残态：dirty 文档 + 工作台正文 + 机检 lastDocId
    mocks.getContent.mockResolvedValueOnce('盘上内容')
    const doc = useDocStore()
    const wb = useWorkbenchStore()
    const check = useCheckStore()
    const ui = useUiStore()
    await doc.open(makeNode('d1'))
    doc.patch('d1', '未落盘编辑')
    wb.textOut = 'A 书生成正文残留'
    check.lastDocId = 'd1'
    const askSpy = vi.spyOn(ui, 'ask')

    routeHolder.route!.params.name = '' // 脏路由
    await flushPromises()

    expect(mocks.saveContent).toHaveBeenCalledTimes(1) // 修复点：残存 dirty 属前书，先落盘
    expect(doc.bookName).toBe('')
    expect(doc.docs.size).toBe(0) // 缓存照切换口径清空
    expect(wb.textOut).toBe('')
    expect(check.lastDocId).toBeNull()
    expect(askSpy).not.toHaveBeenCalled() // 脏路由非切书决断：不弹 Z-8/F1 确认

    // 回到真实书名 → 正常切书流程恢复（lastBook 已复位，不被同书短路误吞）
    routeHolder.route!.params.name = '书A'
    await flushPromises()
    expect(doc.bookName).toBe('书A')
    w.unmount()
  })
})
