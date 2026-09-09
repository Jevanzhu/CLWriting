// @vitest-environment happy-dom
/**
 * CM6 撤销栈同文档外部全量替换清空回归（2026-09-09 修复批，R8B-P1-1 坐实）：
 * CmHost.applyExternalReplace（SSE sync / doc.refresh / 冲突取服务端版 / AI 改写共用路径）
 * 旧实现只挂 Transaction.addToHistory.of(false) 不清旧栈——旧基准的编辑事件仍驻
 * undo/redo 栈，外部替换后 ⌘Z/⇧⌘Z 把旧文档的逆编辑/重做映射进新内容回灌（与切文档
 * X-1 同型危害：applyDocSwitch 头注实测红——redo 栈的文档边界插入事件不被全量替换的
 * addMapping 丢弃）。修复按 applyDocSwitch 同款两步真重置：先卸 history 字段（旧值即丢）、
 * 下一事务重挂（字段重新 init 栈必空），替换事务保持 addToHistory/false（不占用新栈）。
 * 本测试复制 CmHost 修复后的 applyExternalReplace dispatch 形态（historyConf 挂载 +
 * 卸载重挂 + 全量替换 + 选区 clamp 保留），真实包行为级（@codemirror/commands 走
 * web-next 嵌套 node_modules 相对路径——根 vitest 未钉该包别名）。
 */
import { describe, it, expect } from 'vitest'
import { EditorView } from '@codemirror/view'
import { Compartment, Transaction, EditorSelection, type Extension } from '@codemirror/state'
import { history, undo, redo, isolateHistory } from '../../../src/studio/web-next/node_modules/@codemirror/commands'

/** 复制 CmHost 挂载形态：history() 唯一挂载点在 historyConf Compartment（无裸双挂载） */
function mountEditor(doc: string): { view: EditorView; historyConf: Compartment } {
  const historyConf = new Compartment()
  const extensions: Extension[] = [historyConf.of(history())]
  const el = document.createElement('div')
  document.body.appendChild(el)
  return { view: new EditorView({ doc, parent: el, extensions }), historyConf }
}

/** 复制 CmHost 修复后的 applyExternalReplace dispatch 形态：两步真重置（卸载字段 → 重挂
 *  + 全量替换 + 选区 clamp 保留，与 applyDocSwitch 同款清栈语义）。 */
function externalReplace(view: EditorView, historyConf: Compartment, next: string): void {
  const prev = view.state.selection
  const len = next.length
  const ranges = prev.ranges.map((r) => EditorSelection.range(Math.min(r.anchor, len), Math.min(r.head, len)))
  view.dispatch({ effects: historyConf.reconfigure([]) })
  view.dispatch({
    effects: historyConf.reconfigure(history()),
    changes: { from: 0, to: view.state.doc.length, insert: next },
    selection: EditorSelection.create(ranges, prev.mainIndex),
    annotations: [Transaction.addToHistory.of(false), isolateHistory.of('full')],
  })
}

describe('CM6 同文档外部全量替换撤销栈清空（R8B-P1-1）', () => {
  it('有编辑史时外部替换 → undo 不可执行（修复前旧栈回灌，内容不再被旧逆编辑污染）', () => {
    const { view, historyConf } = mountEditor('AAA')
    try {
      view.dispatch({ changes: { from: 3, to: 3, insert: 'XYZ' }, selection: { anchor: 6 } })
      expect(view.state.doc.toString()).toBe('AAAXYZ') // 前置：编辑史非空（undo 本可执行）
      externalReplace(view, historyConf, 'BBB')
      expect(view.state.doc.toString()).toBe('BBB')
      expect(undo(view)).toBe(false) // 旧栈已清：旧基准逆编辑不可回灌
      expect(view.state.doc.toString()).toBe('BBB') // 内容不被污染
    } finally {
      view.destroy()
    }
  })

  it('净零编辑（内容复原但栈非空）后外部替换 → undo 不可执行', () => {
    const { view, historyConf } = mountEditor('AAA')
    try {
      view.dispatch({ changes: { from: 0, to: 0, insert: 'abc' }, selection: { anchor: 3 } })
      view.dispatch({ changes: { from: 0, to: 3, insert: '' }, selection: { anchor: 0 } })
      expect(view.state.doc.toString()).toBe('AAA')
      externalReplace(view, historyConf, 'CCC')
      expect(view.state.doc.toString()).toBe('CCC')
      expect(undo(view)).toBe(false)
      expect(view.state.doc.toString()).toBe('CCC')
    } finally {
      view.destroy()
    }
  })

  it('替换前 undo 过一次（redo 栈非空）→ 替换后 redo 亦不可回灌（redo 栈同清）', () => {
    const { view, historyConf } = mountEditor('AAA')
    try {
      view.dispatch({ changes: { from: 3, to: 3, insert: 'XYZ' }, selection: { anchor: 6 } })
      expect(undo(view)).toBe(true) // 前置：undo 一次 → redo 栈非空
      expect(view.state.doc.toString()).toBe('AAA')
      externalReplace(view, historyConf, 'DDD')
      expect(view.state.doc.toString()).toBe('DDD')
      expect(redo(view)).toBe(false) // redo 栈已清：旧文档重做不可回灌
      expect(undo(view)).toBe(false)
      expect(view.state.doc.toString()).toBe('DDD')
    } finally {
      view.destroy()
    }
  })

  it('替换后新编辑史健康：可编辑、可 undo/redo（字段重挂未被卸残）且选区 clamp 保留', () => {
    const { view, historyConf } = mountEditor('AAA')
    try {
      view.dispatch({ changes: { from: 3, to: 3, insert: 'XYZ' }, selection: { anchor: 6 } })
      externalReplace(view, historyConf, 'BB')
      expect(view.state.doc.toString()).toBe('BB')
      // R62-18/R50-D1-3：替换后光标 clamp 归位（越界→文末），不因历史重置而丢失
      expect(view.state.selection.main.head).toBe(2)
      view.dispatch({ changes: { from: 2, to: 2, insert: 'Q' } })
      expect(view.state.doc.toString()).toBe('BBQ')
      expect(undo(view)).toBe(true)
      expect(view.state.doc.toString()).toBe('BB')
      expect(redo(view)).toBe(true)
      expect(view.state.doc.toString()).toBe('BBQ')
    } finally {
      view.destroy()
    }
  })
})