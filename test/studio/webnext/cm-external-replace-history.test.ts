// @vitest-environment happy-dom
/**
 * CM6 撤销栈同文档外部全量替换清空回归（2026-09-09 修复批，R8B-P1-1 坐实）：
 * CmHost.applyExternalReplace（SSE sync / doc.refresh / 冲突取服务端版 / AI 改写共用路径）
 * 旧实现只挂 Transaction.addToHistory.of(false) 不清旧栈——旧基准的编辑事件仍驻
 * undo/redo 栈，外部替换后 ⌘Z/⇧⌘Z 把旧文档的逆编辑/重做映射进新内容回灌（与切文档
 * X-1 同型危害：applyDocSwitch 头注实测红——redo 栈的文档边界插入事件不被全量替换的
 * addMapping 丢弃）。修复按 applyDocSwitch 同款两步真重置：先卸 history 字段（旧值即丢）、
 * 下一事务重挂（字段重新 init 栈必空），替换事务保持 addToHistory/false（不占用新栈）。
 *
 * R1010c-FE2-P3-5（2026-09-10 全量独立复审修复批）：本文件原为「镜像复制」测试——
 * 自建 mountEditor/externalReplace 复刻 CmHost 的挂载与 dispatch 形态而不 import 组件，
 * 组件漂移（清栈序列被改动/回退）测试不红。重构为真实挂载 CmHost.vue + 真实 CM6（对齐
 * f5-cm-composition-guard / r50-d1-cm-external-keep-ranges 的真实 mount 先例），
 * setProps 变 modelValue（historyKey 不变）驱动 applyExternalReplace 真路径；断言语义
 * 不变：外部替换后 ⌘Z 不触碰新文档内容、redo 亦不回灌、替换后选区 clamp 保留。
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

/** 真实挂载 CmHost（f5/r50-d1 同款）：text 模式 + 固定 historyKey（同文档路径） */
function mountHost(doc: string): ReturnType<typeof mount> {
  return mount(CmHost, { props: { modelValue: doc, mode: 'text', historyKey: 'd1' }, attachTo: document.body })
}

function hostView(w: ReturnType<typeof mount>): EditorView {
  const el = w.element.querySelector('.cm-content')
  expect(el).not.toBeNull()
  const v = EditorView.findFromDOM(el as HTMLElement)
  expect(v).not.toBeNull()
  return v!
}

/** 同文档外部全量替换 = modelValue 变、historyKey 不变：驱动 CmHost watch → applyExternalReplace 真路径 */
async function externalReplace(w: ReturnType<typeof mount>, v: string): Promise<void> {
  await w.setProps({ modelValue: v })
  await new Promise((r) => setTimeout(r, 0))
}

describe('CM6 同文档外部全量替换撤销栈清空（R8B-P1-1 · 真实 CmHost 挂载）', () => {
  it('有编辑史时外部替换 → undo 不可执行（修复前旧栈回灌，内容不再被旧逆编辑污染）', async () => {
    const w = mountHost('AAA')
    const view = hostView(w)
    view.dispatch({ changes: { from: 3, to: 3, insert: 'XYZ' }, selection: { anchor: 6 } })
    expect(view.state.doc.toString()).toBe('AAAXYZ') // 前置：编辑史非空（undo 本可执行）
    await externalReplace(w, 'BBB')
    expect(view.state.doc.toString()).toBe('BBB')
    expect(undo(view)).toBe(false) // 旧栈已清：旧基准逆编辑不可回灌
    expect(view.state.doc.toString()).toBe('BBB') // 内容不被污染
    w.unmount()
  })

  it('净零编辑（内容复原但栈非空）后外部替换 → undo 不可执行', async () => {
    const w = mountHost('AAA')
    const view = hostView(w)
    view.dispatch({ changes: { from: 0, to: 0, insert: 'abc' }, selection: { anchor: 3 } })
    view.dispatch({ changes: { from: 0, to: 3, insert: '' }, selection: { anchor: 0 } })
    expect(view.state.doc.toString()).toBe('AAA')
    await externalReplace(w, 'CCC')
    expect(view.state.doc.toString()).toBe('CCC')
    expect(undo(view)).toBe(false)
    expect(view.state.doc.toString()).toBe('CCC')
    w.unmount()
  })

  it('替换前 undo 过一次（redo 栈非空）→ 替换后 redo 亦不可回灌（redo 栈同清）', async () => {
    const w = mountHost('AAA')
    const view = hostView(w)
    view.dispatch({ changes: { from: 3, to: 3, insert: 'XYZ' }, selection: { anchor: 6 } })
    expect(undo(view)).toBe(true) // 前置：undo 一次 → redo 栈非空
    expect(view.state.doc.toString()).toBe('AAA')
    await externalReplace(w, 'DDD')
    expect(view.state.doc.toString()).toBe('DDD')
    expect(redo(view)).toBe(false) // redo 栈已清：旧文档重做不可回灌
    expect(undo(view)).toBe(false)
    expect(view.state.doc.toString()).toBe('DDD')
    w.unmount()
  })

  it('替换后新编辑史健康：可编辑、可 undo/redo（字段重挂未被卸残）且选区 clamp 保留', async () => {
    const w = mountHost('AAA')
    const view = hostView(w)
    view.dispatch({ changes: { from: 3, to: 3, insert: 'XYZ' }, selection: { anchor: 6 } })
    await externalReplace(w, 'BB')
    expect(view.state.doc.toString()).toBe('BB')
    // R62-18/R50-D1-3：替换后光标 clamp 归位（越界→文末），不因历史重置而丢失
    expect(view.state.selection.main.head).toBe(2)
    view.dispatch({ changes: { from: 2, to: 2, insert: 'Q' } })
    expect(view.state.doc.toString()).toBe('BBQ')
    expect(undo(view)).toBe(true)
    expect(view.state.doc.toString()).toBe('BB')
    expect(redo(view)).toBe(true)
    expect(view.state.doc.toString()).toBe('BBQ')
    w.unmount()
  })
})
