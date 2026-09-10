// @vitest-environment happy-dom
/**
 * CM6 撤销栈切文档清空回归（X-1，第五十六轮）：
 * 根因——新旧文档内容完全相同时（如两个空白新章），旧版切文档不派发替换事务
 * （v === 当前内容），而 historyConf.reconfigure(history()) 对已存在 historyField
 * 携带旧值不重建（CM6 reconfigure 语义），旧文档 undo 栈完整残留：⌘Z 把旧文档的
 * 逆编辑回灌进新文档 → dirty → autosave 落盘污染。修复为两步真重置（卸载 history 扩展
 * → 重挂）+ 恒派发全量替换事务——reconfigure 对已存在字段携带旧值不重建，只有「字段
 * 随 compartment 卸载 → 重新 init」才必然清空；全量替换单独不够（undo 过一次后 redo
 * 栈的文档边界插入事件不被 addMapping 丢弃）。
 *
 * R1010c-FE2-P3-5（2026-09-10 全量独立复审修复批）：本文件原为「镜像复制」测试——
 * 自建 mountEditor/switchDoc 复刻 CmHost 的挂载与 dispatch 形态而不 import 组件，组件
 * 漂移（清栈序列被改动/回退）测试不红。重构为真实挂载 CmHost.vue + 真实 CM6（对齐
 * f5-cm-composition-guard / r50-d1-cm-external-keep-ranges 的真实 mount 先例），
 * setProps 变 historyKey/modelValue 驱动 applyDocSwitch 真路径；断言语义不变：切文档
 * （含同内容切换）后 ⌘Z/⇧⌘Z 不触碰新文档内容、切文档撤销栈两步真重置。
 * undo/redo 走 web-next 嵌套 node_modules 相对路径（根 vitest 未钉该包别名，R61-20
 * 同因），与 CmHost 内裸名 import 解析到同一模块实例。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { EditorView } from '@codemirror/view'
import { undo, redo } from '../../../src/studio/web-next/node_modules/@codemirror/commands'

vi.mock('../../../src/studio/web-next/src/api/settings', () => ({
  getCompletionNames: vi.fn(async () => ({ characters: [], items: [] })),
}))

import CmHost from '../../../src/studio/web-next/src/editor/CmHost.vue'

beforeEach(() => {
  setActivePinia(createPinia())
})

/** 真实挂载 CmHost（f5/r50-d1 同款）：text 模式 + historyKey 驱动切文档路径 */
function mountHost(doc: string, historyKey = 'd1'): ReturnType<typeof mount> {
  return mount(CmHost, { props: { modelValue: doc, mode: 'text', historyKey }, attachTo: document.body })
}

function hostView(w: ReturnType<typeof mount>): EditorView {
  const el = w.element.querySelector('.cm-content')
  expect(el).not.toBeNull()
  const v = EditorView.findFromDOM(el as HTMLElement)
  expect(v).not.toBeNull()
  return v!
}

/** 切文档 = historyKey 变（+ 新内容）：驱动 CmHost watch → applyDocSwitch 真路径 */
async function switchDoc(w: ReturnType<typeof mount>, key: string, v: string): Promise<void> {
  await w.setProps({ historyKey: key, modelValue: v })
  await new Promise((r) => setTimeout(r, 0))
}

/** 在旧文档留下净零编辑史（+abc 后全删）：内容复原但 done 栈非空（undo 本可执行） */
function netZeroEdits(view: EditorView): void {
  view.dispatch({ changes: { from: 0, to: 0, insert: 'abc' }, selection: { anchor: 3 } })
  view.dispatch({ changes: { from: 0, to: 3, insert: '' }, selection: { anchor: 0 } })
}

describe('CM6 切文档撤销栈清空（X-1 · 真实 CmHost 挂载）', () => {
  it('同内容切换（historyKey 变、内容不变）→ undo 不可执行（修复前旧栈残留回灌）', async () => {
    const w = mountHost('AAA')
    const view = hostView(w)
    netZeroEdits(view)
    expect(view.state.doc.toString()).toBe('AAA') // 前置：净零编辑后内容复原
    // 切到内容完全相同的文档 B（historyKey 变、modelValue 仍 'AAA'）——修复前此处无替换事务，旧栈残留
    await switchDoc(w, 'd2', 'AAA')
    expect(view.state.doc.toString()).toBe('AAA')
    expect(undo(view)).toBe(false) // undo 栈已清：旧文档逆编辑不可回灌
    expect(view.state.doc.toString()).toBe('AAA') // 内容不被污染
    w.unmount()
  })

  it('不同内容切换 → undo 不可执行（全文替换丢弃旧事件，回归不回退）', async () => {
    const w = mountHost('AAA')
    const view = hostView(w)
    view.dispatch({ changes: { from: 3, to: 3, insert: 'XYZ' }, selection: { anchor: 6 } })
    expect(view.state.doc.toString()).toBe('AAAXYZ')
    await switchDoc(w, 'd2', 'BBB')
    expect(view.state.doc.toString()).toBe('BBB')
    expect(undo(view)).toBe(false)
    expect(view.state.doc.toString()).toBe('BBB')
    w.unmount()
  })

  it('切换前 undo 过一次（redo 栈非空）→ 切换后 redo 亦不可回灌（redo 栈同清）', async () => {
    const w = mountHost('AAA')
    const view = hostView(w)
    view.dispatch({ changes: { from: 3, to: 3, insert: 'XYZ' }, selection: { anchor: 6 } })
    expect(undo(view)).toBe(true) // 前置：undo 一次 → redo 栈非空
    expect(view.state.doc.toString()).toBe('AAA')
    await switchDoc(w, 'd2', 'CCC')
    expect(view.state.doc.toString()).toBe('CCC')
    expect(redo(view)).toBe(false) // redo 栈已清：旧文档重做不可回灌
    expect(undo(view)).toBe(false)
    expect(view.state.doc.toString()).toBe('CCC')
    w.unmount()
  })

  it('切换后新文档编辑史健康：可编辑、可 undo/redo（两步真重置未卸残新字段）', async () => {
    const w = mountHost('AAA')
    const view = hostView(w)
    await switchDoc(w, 'd2', 'BBB')
    view.dispatch({ changes: { from: 3, to: 3, insert: 'Q' } })
    expect(view.state.doc.toString()).toBe('BBBQ')
    expect(undo(view)).toBe(true)
    expect(view.state.doc.toString()).toBe('BBB')
    expect(redo(view)).toBe(true) // 新文档自身的 redo 正常可用
    expect(view.state.doc.toString()).toBe('BBBQ')
    w.unmount()
  })
})
