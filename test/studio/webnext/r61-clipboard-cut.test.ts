// @vitest-environment happy-dom
/**
 * R61-4（第六十一轮）回归：剪切在剪贴板写失败时不得删除选区。
 * 修复前：catch 只 toast 不 return，dispatch 无条件执行——「文档删了、剪贴板没有」，
 * 用户若信 toast 提示则文字两处皆无（autosave 还会把删除落盘）。
 * 剪贴板经 defineExpose 的 clipboardCut 直调（真实 CM6 编辑器实例）。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { EditorView } from '@codemirror/view'

vi.mock('../../../src/studio/web-next/src/api/settings', () => ({
  getCompletionNames: vi.fn(async () => ({ characters: [], items: [] })),
}))

import CmHost from '../../../src/studio/web-next/src/editor/CmHost.vue'
import { useUiStore } from '../../../src/studio/web-next/src/stores/ui'

beforeEach(() => {
  setActivePinia(createPinia())
})

function mountHost(): ReturnType<typeof mount> {
  return mount(CmHost, {
    props: { modelValue: '初文六字', mode: 'text', historyKey: 'r61-cut' },
    attachTo: document.body,
  })
}

function viewOf(w: ReturnType<typeof mount>): EditorView {
  const el = w.element.querySelector('.cm-content')
  expect(el).not.toBeNull()
  const view = EditorView.findFromDOM(el as HTMLElement)
  expect(view).not.toBeNull()
  return view!
}

describe('R61-4: 剪切剪贴板写失败 → 不删除选区（失败即止）', () => {
  it('writeText 拒绝 → toast 提示、正文不动、选区保留', async () => {
    const w = mountHost()
    const view = viewOf(w)
    view.dispatch({ selection: { anchor: 0, head: 2 } }) // 选中「初文」
    const writeText = vi.fn(() => Promise.reject(new Error('denied')))
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    const ui = useUiStore()
    const toastSpy = vi.spyOn(ui, 'toast')

    await (w.vm as unknown as { clipboardCut: () => Promise<void> }).clipboardCut()
    expect(writeText).toHaveBeenCalled()
    expect(toastSpy).toHaveBeenCalledWith('剪贴板权限被拒绝，剪切未生效', 'error')
    // 修复点：选区文字不被删除（autosave 不会把删除落盘），选区也保留可重试
    expect(view.state.doc.toString()).toBe('初文六字')
    expect(view.state.selection.main.from).toBe(0)
    expect(view.state.selection.main.to).toBe(2)
    w.unmount()
  })

  it('writeText 成功 → 正常删除选区（守卫不误伤正常剪切）', async () => {
    const w = mountHost()
    const view = viewOf(w)
    view.dispatch({ selection: { anchor: 0, head: 2 } })
    const writeText = vi.fn(() => Promise.resolve())
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })

    await (w.vm as unknown as { clipboardCut: () => Promise<void> }).clipboardCut()
    expect(view.state.doc.toString()).toBe('六字')
    w.unmount()
  })
})
