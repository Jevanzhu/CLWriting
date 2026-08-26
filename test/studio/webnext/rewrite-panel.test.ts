// @vitest-environment happy-dom
/**
 * RewritePanel 单测（R-21 第十六轮）：accept() 返回 false（基线漂移拒绝）时不清空
 * 改写指令——作者撤销新编辑后可直接重试，无需重输指令。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, flushPromises, enableAutoUnmount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { nextTick } from 'vue'
import RewritePanel from '../../../src/studio/web-next/src/components/panels/RewritePanel.vue'

const rewriteMock = vi.hoisted(() => ({
  // 面板只读这些字段：result 存在才渲染 diff/接受按钮；run/accept/reject/clear 由用例覆写
  loading: false,
  error: null as string | null,
  result: null as unknown,
  run: vi.fn(async () => {}),
  accept: vi.fn((): boolean => true),
  reject: vi.fn(),
  clear: vi.fn(),
}))

// workspace mock 需响应式（R63-9 watch(docId) 才能触发）——reactive 代理存 hoisted 槽供用例改值
const wsMock = vi.hoisted(() => ({ state: null as unknown as { activeDocId: string | null; editorGetSelection: unknown } }))

vi.mock('../../../src/studio/web-next/src/stores/rewrite', () => ({
  useRewriteStore: () => rewriteMock,
}))
vi.mock('../../../src/studio/web-next/src/stores/workspace', async () => {
  const { reactive } = await import('vue')
  wsMock.state = reactive({ activeDocId: 'doc_1', editorGetSelection: null })
  return { useWorkspaceStore: () => wsMock.state }
})
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

// R63-9 用例对 clear 调用次数敏感：不卸载的旧 wrapper 其 watch(docId) 存活到
// 后续用例，对 beforeEach 的 docId 复位也会补触发 clear——每用例后统一卸载隔离
enableAutoUnmount(afterEach)

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  rewriteMock.loading = false
  rewriteMock.error = null
  rewriteMock.result = null
  if (wsMock.state) wsMock.state.activeDocId = 'doc_1'
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

describe('R63-9: 切文档清空改写结果（CheckPanel X-P2-15 同款契约）', () => {
  it('docId 切换 → rewrite.clear()——残留 diff 不跨文档（不阻断新文档；正文相同文档不可跨文档接受）', async () => {
    rewriteMock.result = { ok: true, mode: 'whole', original: '旧', rewritten: '新', diff: [{ type: 'same', text: 'x' }] }
    const w = mountPanel()
    await flushPromises()
    // 残留 diff 在场（接受按钮可见）→ 切文档 → 必须清
    expect(w.find('.rw-accept').exists()).toBe(true)
    wsMock.state!.activeDocId = 'doc_2'
    await nextTick()
    expect(rewriteMock.clear).toHaveBeenCalledTimes(1)
  })

  it('文档不变 → 不误清（clear 零调用）', async () => {
    rewriteMock.result = { ok: true, mode: 'whole', original: '旧', rewritten: '新', diff: [{ type: 'same', text: 'x' }] }
    const w = mountPanel()
    await flushPromises()
    await nextTick()
    expect(rewriteMock.clear).not.toHaveBeenCalled()
    expect(w.find('.rw-accept').exists()).toBe(true)
  })
})
