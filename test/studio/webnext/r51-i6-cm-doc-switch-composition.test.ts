// @vitest-environment happy-dom
/**
 * R51-I-6（五十一轮）回归：CmHost 切文档分支的 IME 组合期守卫（真实 CM6 行为级）。
 *
 * 组合期切章此前立即派发全量替换——打断 IME 组合丢字（同文档路径 F5 已有守卫，切文档
 * 分支漏配）。修复后组合期切章挂起（pendingDocSwitch）：组合结束（compositionend +
 * 延迟一拍冲排）后消费；挂起窗口内本视图的输入 emit 抑制（父层 entry 已指向新章，
 * 照常回写会把旧章文本整段写进新章——跨章污染）。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { EditorView } from '@codemirror/view'

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
    { props: { modelValue: '旧章初文', historyKey: 'd1', mode: 'text' }, attachTo: document.body },
  )
}

function contentEl(w: ReturnType<typeof mount>): HTMLElement {
  const el = w.element.querySelector('.cm-content')
  expect(el).not.toBeNull()
  return el as HTMLElement
}

function docText(w: ReturnType<typeof mount>): string {
  return contentEl(w).textContent ?? ''
}

function viewOf(w: ReturnType<typeof mount>): EditorView {
  const view = EditorView.findFromDOM(contentEl(w))
  expect(view).not.toBeNull()
  return view!
}

describe('R51-I-6: 切文档分支的组合期守卫', () => {
  it('组合期切章 → 挂起不替换（修复前：立即替换打断组合丢字）；compositionend 后消费', async () => {
    const w = mountHost()
    const view = viewOf(w)

    contentEl(w).dispatchEvent(new Event('compositionstart', { bubbles: true }))
    await w.setProps({ modelValue: '新章内容', historyKey: 'd2' })
    await new Promise((r) => setTimeout(r, 0))
    expect(docText(w)).toBe('旧章初文') // 修复点：组合中不切，挂起

    contentEl(w).dispatchEvent(new Event('compositionend', { bubbles: true }))
    await new Promise((r) => setTimeout(r, 0))
    // 消费挂起：真重置路径（全量替换 + 章首锚定，对齐 I-3 口径）
    expect(docText(w)).toBe('新章内容')
    expect(view.state.selection.main.head).toBe(0)
    w.unmount()
  })

  it('挂起窗口内本视图输入不 emit（父层 entry 已指向新章，照常回写=跨章污染）；消费后 emit 恢复', async () => {
    const w = mountHost()
    const view = viewOf(w)

    contentEl(w).dispatchEvent(new Event('compositionstart', { bubbles: true }))
    await w.setProps({ modelValue: '新章内容', historyKey: 'd2' })
    await new Promise((r) => setTimeout(r, 0))
    expect(w.emitted('update:modelValue')).toBeUndefined() // 挂起本身不产生回写

    // 组合期续打（f5 B-1 同款手法：真实 dispatch 进 CM6 state 模拟组合文本上屏）
    const len = view.state.doc.length
    view.dispatch({ changes: { from: len, to: len, insert: '续打' } })
    await new Promise((r) => setTimeout(r, 0))
    expect(w.emitted('update:modelValue')).toBeUndefined() // 修复点：挂起窗口 emit 抑制
    expect(docText(w)).toBe('旧章初文续打') // 输入留在本视图

    contentEl(w).dispatchEvent(new Event('compositionend', { bubbles: true }))
    await new Promise((r) => setTimeout(r, 0))
    expect(docText(w)).toBe('新章内容') // 挂起的切文档生效
    // 四轮-E402：挂起消费（applyDocSwitch）的程序化替换事务不再回发 emit——原断言
    //「消费即回发 '新章内容'」在 E402 后移除：回发经父层 mergeFm 规范形往返，对非规范
    // fm 文件零输入置脏（autosave 静默改写）
    expect(w.emitted('update:modelValue')).toBeUndefined()
    // 原断言意图保留：消费通道的抑制不粘滞，随后的真实输入照常 emit（emit 恢复常态）
    view.dispatch({ changes: { from: view.state.doc.length, to: view.state.doc.length, insert: '续' } })
    await new Promise((r) => setTimeout(r, 0))
    const emits = w.emitted('update:modelValue') ?? []
    expect(emits.length).toBe(1)
    expect(emits[0]![0]).toBe('新章内容续')
    w.unmount()
  })

  it('非组合态切章 → 即时切换不受守卫影响（守卫不误伤常规路径）', async () => {
    const w = mountHost()
    await w.setProps({ modelValue: '新章内容', historyKey: 'd2' })
    await new Promise((r) => setTimeout(r, 0))
    expect(docText(w)).toBe('新章内容')
    w.unmount()
  })
})
