// @vitest-environment happy-dom
/**
 * 0918独立重评修复批（F002）回归：「设定速查」跨视图插入悬挂。
 *
 * 修复前：onInsert 仅在无 activeDocId 时 toast；activeView 非 editor 时（EditorView 在
 * Book.vue 按 v-if 卸载）pendingInsert 入槽无人即时消费、点击零反馈。修复后：非 editor
 * 视图点击 → toast「已挂起」+ 照常 requestInsert 入槽；切回 editor 视图（EditorView 挂载
 * → onMounted 补消费 / doc 落位 nextTick 补消费）→ 插入发生、槽位清空。
 *
 * EditorView 挂载消费面 harness 对齐 editor-view.test.ts（CmHost stub 暴露 insertText spy）。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import type { TreeNode } from '../../../src/studio/web-next/src/types/tree'

const mocks = vi.hoisted(() => ({
  getContent: vi.fn(),
  saveContent: vi.fn(),
  finalizeDoc: vi.fn(),
  getConfig: vi.fn(),
  // CmHost stub 暴露的 insertText spy（EditorView 消费路径的断言口）
  insertText: vi.fn(),
  openSearch: vi.fn(),
}))

vi.mock('../../../src/studio/web-next/src/api/documents', () => ({
  getContent: mocks.getContent,
  getContentPayload: vi.fn(
    async (...a: Parameters<typeof mocks.getContent>) => ({ content: await mocks.getContent(...a) }),
  ),
  saveContent: mocks.saveContent,
  finalizeDoc: mocks.finalizeDoc,
  updateChapterMetaDoc: vi.fn(),
}))
vi.mock('../../../src/studio/web-next/src/api/books', () => ({
  getConfig: mocks.getConfig,
  getTree: vi.fn(),
}))
vi.mock('../../../src/studio/web-next/src/api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/studio/web-next/src/api/client')>()
  return { ...actual, getToken: vi.fn(() => null) }
})
// CodeMirror 在 happy-dom 里起不来——stub 掉，按 CmHostExposed 契约 expose insertText
vi.mock('../../../src/studio/web-next/src/editor/CmHost.vue', () => ({
  default: {
    name: 'CmHost',
    setup(_props: unknown, { expose }: { expose: (o: Record<string, unknown>) => void }) {
      expose({ insertText: mocks.insertText, openSearch: mocks.openSearch })
      return () => null
    },
  },
}))

import ContextQuickPanel from '../../../src/studio/web-next/src/components/panels/ContextQuickPanel.vue'
import EditorView from '../../../src/studio/web-next/src/views/EditorView.vue'
import { useTreeStore } from '../../../src/studio/web-next/src/stores/tree'
import { useDocStore } from '../../../src/studio/web-next/src/stores/doc'
import { useWorkspaceStore } from '../../../src/studio/web-next/src/stores/workspace'
import { useUiStore } from '../../../src/studio/web-next/src/stores/ui'

/** 设定组树：根「设定」目录 + 叶子「势力」（ContextQuickPanel 的 settings 源） */
function settingTree(): TreeNode[] {
  return [
    {
      path: '设定',
      name: '设定',
      isDirectory: true,
      role: 'group',
      children: [
        { path: '设定/势力.md', name: '势力', isDirectory: false, role: 'setting', docId: 'd9', status: 'draft', children: [] },
      ],
    },
  ]
}

/** 章节节点（EditorView doc.open 消费面） */
function chapterNode(docId: string): TreeNode {
  return {
    path: '写作/正文/第1章-标题.md',
    name: '第1章-标题.md',
    isDirectory: false,
    role: 'chapter',
    docId,
    status: 'draft',
    children: [],
  }
}

beforeEach(() => {
  setActivePinia(createPinia())
  mocks.getContent.mockReset().mockResolvedValue('---\n标题: 标题\n---\n\n正文')
  mocks.saveContent.mockReset()
  mocks.finalizeDoc.mockReset()
  mocks.getConfig.mockReset().mockResolvedValue({ kind: 'long' })
  mocks.insertText.mockReset()
  mocks.openSearch.mockReset()
})

describe('F002: 设定速查跨视图插入', () => {
  let w: ReturnType<typeof mount> | null = null

  afterEach(async () => {
    w?.unmount()
    w = null
    await flushPromises()
  })

  it('非 editor 视图点击 → toast 挂起反馈 + pendingInsert 照常入槽', async () => {
    const tree = useTreeStore()
    const ws = useWorkspaceStore()
    tree.raw = settingTree()
    ws.activeDocId = 'd1'
    ws.activeView = 'workbench' // 编辑器视图未挂载（EditorView v-if 卸载形态）

    const ui = useUiStore()
    const toastSpy = vi.spyOn(ui, 'toast')
    w = mount(ContextQuickPanel, { props: { bookName: 'test-book' } })
    await flushPromises()

    const btn = w.find('.insert-btn')
    expect(btn.exists()).toBe(true)
    await btn.trigger('click')
    await flushPromises()

    expect(toastSpy).toHaveBeenCalledWith('已挂起：回到编辑器视图后自动插入', 'info')
    expect(ws.pendingInsert?.text).toBe('势力') // 入槽待消费（修复前点击零反馈且无人消费）
  })

  it('切回 editor 视图（挂载 EditorView）→ 挂起信号被消费，插入发生、槽位清空', async () => {
    const tree = useTreeStore()
    const doc = useDocStore()
    const ws = useWorkspaceStore()
    doc.setBook('test-book')
    tree.raw = settingTree()
    ws.activeDocId = 'd1'
    ws.activeView = 'workbench'
    ws.requestInsert('势力') // 跨视图插入入槽（EditorView 未挂载，无人即时消费）
    expect(ws.pendingInsert).not.toBeNull()

    // 切回编辑器视图：树给出 docId 对应节点 + EditorView 挂载 → doc.open 落位 → 补消费
    tree.raw = [...settingTree(), chapterNode('d1')]
    w = mount(EditorView, { props: { docId: 'd1' } })
    await flushPromises()

    await vi.waitFor(() => expect(mocks.insertText).toHaveBeenCalledWith('势力'))
    // R0916-7-P3-24：仅插入成功才占消费权（P2-21 语义保持）——消费后令牌惰性
    //（重复消费 null），槽位不再走读后置 null
    expect(ws.pendingInsert?.consume()).toBeNull()
  })
})
