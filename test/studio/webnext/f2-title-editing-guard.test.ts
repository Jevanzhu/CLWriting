// @vitest-environment happy-dom
/**
 * F2（五十九轮）回归：标题编辑守卫——标题框聚焦（新标题未提交）或提交在途期间，
 * EditorView 的 titleModel 回写 watch（源 entry.content）不得执行，否则正文任意
 * 键入/refresh 触发回写，把作者正在输入的新标题静默覆盖为 fm 旧值。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

const mocks = vi.hoisted(() => ({
  getContent: vi.fn(),
  saveContent: vi.fn(),
  finalizeDoc: vi.fn(),
  updateChapterMetaDoc: vi.fn(),
}))
vi.mock('../../../src/studio/web-next/src/api/documents', () => ({
  getContent: mocks.getContent,
  saveContent: mocks.saveContent,
  finalizeDoc: mocks.finalizeDoc,
  updateChapterMetaDoc: mocks.updateChapterMetaDoc,
}))
vi.mock('../../../src/studio/web-next/src/api/books', () => ({
  getConfig: vi.fn(async () => ({ kind: 'long' })),
  getTree: vi.fn(),
}))
vi.mock('../../../src/studio/web-next/src/api/client', () => ({
  ApiError: class ApiError extends Error {
    status = 0
    code?: string
  },
  getToken: vi.fn(() => null),
}))
// CM6 与本缺陷无关（守卫在 watch 层），stub 掉保持测试轻量
vi.mock('../../../src/studio/web-next/src/editor/CmHost.vue', () => ({
  default: { name: 'CmHost', template: '<div class="cm-host-stub" />' },
}))

import EditorView from '../../../src/studio/web-next/src/views/EditorView.vue'
import { useDocStore } from '../../../src/studio/web-next/src/stores/doc'
import { useTreeStore } from '../../../src/studio/web-next/src/stores/tree'
import { useWorkspaceStore } from '../../../src/studio/web-next/src/stores/workspace'
import type { TreeNode } from '../../../src/studio/web-next/src/types/tree'

const BOOK = 'test-book'
const NODE: TreeNode = {
  path: '写作/正文/0001-x.md',
  name: '0001-x.md',
  isDirectory: false,
  role: 'chapter',
  docId: 'd1',
  status: 'draft',
  children: [],
} as TreeNode

const FM_OLD = '---\n标题: 旧标题\n---\n\n正文'

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  mocks.getContent.mockResolvedValue(FM_OLD)
  mocks.updateChapterMetaDoc.mockResolvedValue({ ok: true })
})

describe('F2: 标题编辑期间 content 变化不回写 titleModel', () => {
  it('聚焦改标题 → 正文键入（patch）→ 新标题保留；提交收尾后回写恢复', async () => {
    const doc = useDocStore()
    const tree = useTreeStore()
    vi.spyOn(tree, 'load').mockResolvedValue(undefined)
    doc.setBook(BOOK)
    await doc.open(NODE)
    useWorkspaceStore().activeDocId = 'd1' // 标题提交入口的前置条件（dd-P2 守卫读它）

    const w = mount(EditorView, { props: { docId: 'd1' } })
    await flushPromises()
    // 纸面标题只读展示读 titleModel——作为断言面
    expect(w.find('.page-title').text()).toBe('旧标题')

    // 作者聚焦标题框并改成新标题（未提交）
    const input = w.find('input.bar-title')
    await input.trigger('focus')
    await input.setValue('新标题')

    // 正文任意键入触发 entry.content 变化（watch 源）——修复前：titleModel 被回写覆盖
    doc.patch('d1', '---\n标题: 旧标题\n---\n\n正文继续')
    await flushPromises()
    expect(w.find('.page-title').text()).toBe('新标题') // 修复点：未被 fm 旧值覆盖

    // blur 提交：updateChapterMetaDoc 成功 + refresh 对齐磁盘（fm 已是新标题）后，
    // 编辑态解除、回写恢复——后续 content 变化正常同步
    mocks.getContent.mockResolvedValue('---\n标题: 新标题\n---\n\n正文继续')
    await input.trigger('blur')
    await flushPromises()
    // refresh 内部 sha256Revision 跨宏任务（WebCrypto）——提交收尾（finally 解除编辑态）
    // 在其后落定，多泵一拍宏任务再验「守卫已解除」
    await new Promise((r) => setTimeout(r, 0))
    await new Promise((r) => setTimeout(r, 0))
    await flushPromises()
    expect(mocks.updateChapterMetaDoc).toHaveBeenCalled()
    expect(w.find('.page-title').text()).toBe('新标题')

    doc.patch('d1', '---\n标题: 更新的标题\n---\n\n正文')
    await flushPromises()
    expect(w.find('.page-title').text()).toBe('更新的标题') // 守卫已解除，回写恢复
    w.unmount()
  })

  it('未聚焦 → 守卫不误伤：content 变化照常回写', async () => {
    const doc = useDocStore()
    doc.setBook(BOOK)
    await doc.open(NODE)
    const w = mount(EditorView, { props: { docId: 'd1' } })
    await flushPromises()
    doc.patch('d1', '---\n标题: 外部改的标题\n---\n\n正文')
    await flushPromises()
    expect(w.find('.page-title').text()).toBe('外部改的标题')
    w.unmount()
  })
})
