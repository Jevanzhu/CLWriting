// @vitest-environment happy-dom
/**
 * R51-I-3（五十一轮）回归：CmHost 切文档后光标锚定章首（真实 CM6 行为级）。
 *
 * 切文档的全量替换事务此前不显式给 selection——旧光标被 mapPos 到替换区间边界
 * （文末，R62-18 同源语义），切章后光标落章末。修复后 selection 锚定 0（章首），
 * 对齐同文档路径（applyExternalReplace）的选区处理口径。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { EditorView } from '@codemirror/view'
// @codemirror/commands 根目录解析不到（web-next 嵌套安装），按 cm-history-reset 先例
// 从嵌套路径取真实实例（与组件同模块）
import { undo } from '../../../src/studio/web-next/node_modules/@codemirror/commands'

vi.mock('../../../src/studio/web-next/src/api/settings', () => ({
  getCompletionNames: vi.fn(async () => ({ characters: [], items: [] })),
}))

import CmHost from '../../../src/studio/web-next/src/editor/CmHost.vue'

beforeEach(() => {
  setActivePinia(createPinia())
})

function mountHost(): ReturnType<typeof mount> {
  return mount(
    CmHost,
    { props: { modelValue: '第一章的正文内容', historyKey: 'd1', mode: 'text' }, attachTo: document.body },
  )
}

function viewOf(w: ReturnType<typeof mount>): EditorView {
  const el = w.element.querySelector('.cm-content')
  expect(el).not.toBeNull()
  const view = EditorView.findFromDOM(el as HTMLElement)
  expect(view).not.toBeNull()
  return view!
}

function docText(w: ReturnType<typeof mount>): string {
  return (w.element.querySelector('.cm-content') as HTMLElement).textContent ?? ''
}

describe('R51-I-3: 切文档后光标锚定章首', () => {
  it('切章全量替换后 selection 落 0（修复前：旧章末光标 mapPos 到新章末）', async () => {
    const w = mountHost()
    const view = viewOf(w)
    // 阅读位置在旧章末（作者打字/读到哪里就是哪里；章末位置经全区间替换映射到新章末，
    // 即评审所述「切章后光标落章末」）
    view.dispatch({ selection: { anchor: 8 } })
    await w.setProps({ modelValue: '第二章全新内容', historyKey: 'd2' })
    await new Promise((r) => setTimeout(r, 0))
    expect(docText(w)).toBe('第二章全新内容')
    const sel = view.state.selection.main
    expect(sel.anchor).toBe(0)
    expect(sel.head).toBe(0)
    w.unmount()
  })

  it('切文档真重置 undo 栈（X-1 既有口径不回归）：⌘Z 不把旧文档回灌进新文档', async () => {
    const w = mountHost()
    const view = viewOf(w)
    view.dispatch({ changes: { from: 0, to: 0, insert: '旧章编辑' } }) // 旧章留下 undo 事件
    await w.setProps({ modelValue: '第二章全新内容', historyKey: 'd2' })
    await new Promise((r) => setTimeout(r, 0))
    expect(undo(view)).toBe(false) // 切文档后旧栈清空（undoCommand 无效）
    expect((w.element.querySelector('.cm-content') as HTMLElement).textContent).toBe('第二章全新内容')
    w.unmount()
  })
})
