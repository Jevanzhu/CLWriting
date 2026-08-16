// @vitest-environment happy-dom
/**
 * EditorView 组件测试（cc 轮批 3 补强）：持久化 activeDocId 恢复竞态。
 *
 * CC-P1-4：书打开时 getBookPrefs（快）可能先于 tree.load（慢，大书含 git status
 * + 全盘字数）返回——prefs 把 activeDocId 顶上时 byDocId 仍为空，旧实现 watch 仅挂
 * props.docId，触发一次空查找后静默放弃，树到达后无补偿重试 → 编辑器停留空态，
 * 作者需手动点树。修复：watch 同时挂 tree.byDocId.get(docId)，树加载完成重触发补开。
 *
 * 本文件只测恢复竞态这一组件行为；doc store 逻辑（open/save/refresh）在 doc.test.ts。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

const mocks = vi.hoisted(() => ({
  getContent: vi.fn(),
  saveContent: vi.fn(),
  finalizeDoc: vi.fn(),
  getConfig: vi.fn(),
}))

vi.mock('../../../src/studio/web-next/src/api/documents', () => ({
  getContent: mocks.getContent,
  saveContent: mocks.saveContent,
  finalizeDoc: mocks.finalizeDoc,
  updateChapterMetaDoc: vi.fn(),
}))
vi.mock('../../../src/studio/web-next/src/api/books', () => ({
  getConfig: mocks.getConfig,
  getTree: vi.fn(),
}))
vi.mock('../../../src/studio/web-next/src/api/client', () => ({
  ApiError: class ApiError extends Error {
    status = 0
    code?: string
  },
  getToken: vi.fn(() => null),
}))
// CodeMirror 在 happy-dom 里起不来，且本测试不碰编辑器交互——stub 掉
vi.mock('../../../src/studio/web-next/src/editor/CmHost.vue', () => ({
  default: { name: 'CmHost', template: '<div class="cm-host-stub" />' },
}))

import EditorView from '../../../src/studio/web-next/src/views/EditorView.vue'
import { useDocStore } from '../../../src/studio/web-next/src/stores/doc'
import { useTreeStore } from '../../../src/studio/web-next/src/stores/tree'
import type { TreeNode } from '../../../src/studio/web-next/src/types/tree'

const BOOK = 'test-book'

function makeNode(docId: string): TreeNode {
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
})

describe('EditorView: activeDocId 恢复竞态（CC-P1-4）', () => {
  it('prefs 恢复先于 tree.load 到达 → 树加载完成后补开，不停留空态', async () => {
    const doc = useDocStore()
    const tree = useTreeStore()
    doc.setBook(BOOK)

    // 场景前置：EditorView 已挂载（activeDocId 尚为 null）
    const w = mount(EditorView, { props: { docId: null } })
    await flushPromises()

    // prefs 恢复把 activeDocId 顶上——此时树还在路上（byDocId 空），无可打开
    await w.setProps({ docId: 'd1' })
    await flushPromises()
    expect(doc.get('d1')).toBeUndefined()
    expect(mocks.getContent).not.toHaveBeenCalled()

    // tree.load 完成：byDocId 出现 d1 → watch 重触发补开（修复前：永不触发）
    tree.raw = [makeNode('d1')]
    await flushPromises()
    await flushPromises()
    expect(doc.get('d1')).toBeDefined()
    expect(mocks.getContent).toHaveBeenCalledWith(BOOK, '写作/正文/第1章-标题.md')
  })

  it('树先到、docId 后到（正常点击/晚恢复）→ 一次 open，不重复拉取', async () => {
    const doc = useDocStore()
    const tree = useTreeStore()
    doc.setBook(BOOK)
    tree.raw = [makeNode('d1')]

    const w = mount(EditorView, { props: { docId: null } })
    await flushPromises()
    await w.setProps({ docId: 'd1' })
    await flushPromises()
    await flushPromises()

    expect(doc.get('d1')).toBeDefined()
    expect(mocks.getContent).toHaveBeenCalledTimes(1)
  })
})
