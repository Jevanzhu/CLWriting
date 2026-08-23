// @vitest-environment happy-dom
/**
 * RewritePanel 单测（R-21 第十六轮）：accept() 返回 false（基线漂移拒绝）时不清空
 * 改写指令——作者撤销新编辑后可直接重试，无需重输指令。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import RewritePanel from '../../../src/studio/web-next/src/components/panels/RewritePanel.vue'

const rewriteMock = vi.hoisted(() => ({
  // 面板只读这些字段：result 存在才渲染 diff/接受按钮；run/accept/reject 由用例覆写
  loading: false,
  error: null as string | null,
  result: null as unknown,
  run: vi.fn(async () => {}),
  accept: vi.fn((): boolean => true),
  reject: vi.fn(),
}))

vi.mock('../../../src/studio/web-next/src/stores/rewrite', () => ({
  useRewriteStore: () => rewriteMock,
}))
vi.mock('../../../src/studio/web-next/src/stores/workspace', () => ({
  useWorkspaceStore: () => ({ activeDocId: 'doc_1', editorGetSelection: null }),
}))
vi.mock('../../../src/studio/web-next/src/stores/tree', () => ({
  useTreeStore: () => ({
    byDocId: new Map([['doc_1', { path: '写作/正文/001-开篇.md', docId: 'doc_1' }]]),
  }),
}))
vi.mock('../../../src/studio/web-next/src/stores/ui', () => ({
  useUiStore: () => ({ aiAvailable: true }),
}))

function mountPanel() {
  return mount(RewritePanel, { props: { bookName: '书A' } })
}

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  rewriteMock.loading = false
  rewriteMock.error = null
  rewriteMock.result = null
})

describe('R-21: accept 被拒时保留指令', () => {
  it('accept 返回 false（基线漂移拒绝）→ instruction 不清空', async () => {
    rewriteMock.result = { ok: true, mode: 'whole', original: '旧', rewritten: '新', diff: [{ type: 'same', text: 'x' }] }
    rewriteMock.accept.mockReturnValue(false)
    const w = mountPanel()
    await flushPromises()

    const ta = w.find('textarea')
    await ta.setValue('让开头更紧张')
    await w.find('.rw-accept').trigger('click')
    expect(rewriteMock.accept).toHaveBeenCalledWith('书A', 'doc_1')
    // 修复前：无条件清空，作者撤销新编辑后须重输指令
    expect((ta.element as HTMLTextAreaElement).value).toBe('让开头更紧张')
  })

  it('accept 成功 → instruction 清空（守卫不误伤常规路径）', async () => {
    rewriteMock.result = { ok: true, mode: 'whole', original: '旧', rewritten: '新', diff: [{ type: 'same', text: 'x' }] }
    rewriteMock.accept.mockReturnValue(true)
    const w = mountPanel()
    await flushPromises()

    const ta = w.find('textarea')
    await ta.setValue('让开头更紧张')
    await w.find('.rw-accept').trigger('click')
    expect((ta.element as HTMLTextAreaElement).value).toBe('')
  })
})
