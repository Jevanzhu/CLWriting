// @vitest-environment happy-dom
/**
 * CmHost 切文档事务的两面守卫（真实 CM6 行为级）：光标锚定与 IME 组合期挂起。
 *
 * R51-I-3（五十一轮）：切文档后光标锚定章首——切文档的全量替换事务此前不显式给
 * selection，旧光标被 mapPos 到替换区间边界（文末，R62-18 同源语义），切章后光标落
 * 章末。修复后 selection 锚定 0（章首），对齐同文档路径（applyExternalReplace）的
 * 选区处理口径；undo 栈真重置（X-1 既有口径）。
 *
 * R51-I-6（五十一轮）：切文档分支的 IME 组合期守卫——组合期切章此前立即派发全量
 * 替换，打断 IME 组合丢字（同文档路径 F5 已有守卫，切文档分支漏配）。修复后组合期
 * 切章挂起（pendingDocSwitch）：组合结束（compositionend + 延迟一拍冲排）后消费；
 * 挂起窗口内本视图的输入 emit 抑制（父层 entry 已指向新章，照常回写会把旧章文本
 * 整段写进新章——跨章污染）。
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

function mountHost(modelValue = '第一章的正文内容'): ReturnType<typeof mount> {
  return mount(
    CmHost,
    { props: { modelValue, historyKey: 'd1', mode: 'text' }, attachTo: document.body },
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

/** 泵一拍宏任务：CmHost 的切文档事务经 setTimeout(0) 冲排 */
const flushTick = () => new Promise((r) => setTimeout(r, 0))

describe('R51-I-3: 切文档后光标锚定章首', () => {
  it('切章全量替换后 selection 落 0（修复前：旧章末光标 mapPos 到新章末）', async () => {
    const w = mountHost()
    const view = viewOf(w)
    // 阅读位置在旧章末（作者打字/读到哪里就是哪里；章末位置经全区间替换映射到新章末，
    // 即评审所述「切章后光标落章末」）
    view.dispatch({ selection: { anchor: 8 } })
    await w.setProps({ modelValue: '第二章全新内容', historyKey: 'd2' })
    await flushTick()
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
    await flushTick()
    expect(undo(view)).toBe(false) // 切文档后旧栈清空（undoCommand 无效）
    expect(docText(w)).toBe('第二章全新内容')
    w.unmount()
  })
})

describe('R51-I-6: 切文档分支的组合期守卫', () => {
  it('组合期切章 → 挂起不替换（修复前：立即替换打断组合丢字）；compositionend 后消费', async () => {
    const w = mountHost('旧章初文')
    const view = viewOf(w)

    contentEl(w).dispatchEvent(new Event('compositionstart', { bubbles: true }))
    await w.setProps({ modelValue: '新章内容', historyKey: 'd2' })
    await flushTick()
    expect(docText(w)).toBe('旧章初文') // 修复点：组合中不切，挂起

    contentEl(w).dispatchEvent(new Event('compositionend', { bubbles: true }))
    await flushTick()
    // 消费挂起：真重置路径（全量替换 + 章首锚定，对齐 I-3 口径）
    expect(docText(w)).toBe('新章内容')
    expect(view.state.selection.main.head).toBe(0)
    w.unmount()
  })

  it('挂起窗口内本视图输入不 emit（父层 entry 已指向新章，照常回写=跨章污染）；消费后 emit 恢复', async () => {
    const w = mountHost('旧章初文')
    const view = viewOf(w)

    contentEl(w).dispatchEvent(new Event('compositionstart', { bubbles: true }))
    await w.setProps({ modelValue: '新章内容', historyKey: 'd2' })
    await flushTick()
    expect(w.emitted('update:modelValue')).toBeUndefined() // 挂起本身不产生回写

    // 组合期续打（f5 B-1 同款手法：真实 dispatch 进 CM6 state 模拟组合文本上屏）
    const len = view.state.doc.length
    view.dispatch({ changes: { from: len, to: len, insert: '续打' } })
    await flushTick()
    expect(w.emitted('update:modelValue')).toBeUndefined() // 修复点：挂起窗口 emit 抑制
    expect(docText(w)).toBe('旧章初文续打') // 输入留在本视图

    contentEl(w).dispatchEvent(new Event('compositionend', { bubbles: true }))
    await flushTick()
    expect(docText(w)).toBe('新章内容') // 挂起的切文档生效
    // 四轮-E402：挂起消费（applyDocSwitch）的程序化替换事务不再回发 emit——原断言
    //「消费即回发 '新章内容'」在 E402 后移除：回发经父层 mergeFm 规范形往返，对非规范
    // fm 文件零输入置脏（autosave 静默改写）
    expect(w.emitted('update:modelValue')).toBeUndefined()
    // 原断言意图保留：消费通道的抑制不粘滞，随后的真实输入照常 emit（emit 恢复常态）
    view.dispatch({ changes: { from: view.state.doc.length, to: view.state.doc.length, insert: '续' } })
    await flushTick()
    const emits = w.emitted('update:modelValue') ?? []
    expect(emits.length).toBe(1)
    expect(emits[0]![0]).toBe('新章内容续')
    w.unmount()
  })

  it('非组合态切章 → 即时切换不受守卫影响（守卫不误伤常规路径）', async () => {
    const w = mountHost('旧章初文')
    await w.setProps({ modelValue: '新章内容', historyKey: 'd2' })
    await flushTick()
    expect(docText(w)).toBe('新章内容')
    w.unmount()
  })
})
