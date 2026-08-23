// @vitest-environment happy-dom
/**
 * CM6 撤销栈切文档清空回归（X-1，第五十六轮）：
 * 根因——新旧文档内容完全相同时（如两个空白新章），旧版切文档不派发替换事务
 * （v === 当前内容），而 historyConf.reconfigure(history()) 对已存在 historyField
 * 携带旧值不重建（CM6 reconfigure 语义），旧文档 undo 栈完整残留：⌘Z 把旧文档的
 * 逆编辑回灌进新文档 → dirty → autosave 落盘污染。修复为两步真重置（卸载 history 扩展
 * → 重挂）+ 恒派发全量替换事务——reconfigure 对已存在字段携带旧值不重建，只有「字段
 * 随 compartment 卸载 → 重新 init」才必然清空；全量替换单独不够（undo 过一次后 redo
 * 栈的文档边界插入事件不被 addMapping 丢弃）。本测试复制 CmHost 切文档 dispatch 序列
 * （historyConf 挂载形态 + docSwitch 分支事务形态）锁死该契约（真实包行为级，
 * @codemirror/commands 走 web-next 嵌套 node_modules 相对路径——根 vitest 未钉该包别名）。
 */
import { describe, it, expect } from 'vitest'
import { EditorView } from '@codemirror/view'
import { Compartment, Transaction, type Extension } from '@codemirror/state'
import { history, undo, redo, isolateHistory } from '../../../src/studio/web-next/node_modules/@codemirror/commands'

/** 复制 CmHost 挂载形态：history() 唯一挂载点在 historyConf Compartment（无裸双挂载） */
function mountEditor(doc: string): { view: EditorView; historyConf: Compartment } {
  const historyConf = new Compartment()
  const extensions: Extension[] = [historyConf.of(history())]
  const el = document.createElement('div')
  document.body.appendChild(el)
  return { view: new EditorView({ doc, parent: el, extensions }), historyConf }
}

/** 复制 CmHost 修复后的 docSwitch 分支 dispatch 形态：两步真重置（卸载字段 → 重挂 +
 *  恒全量替换 + 注解）。单靠替换事务不够：文档边界插入事件不被 addMapping 丢弃。 */
function switchDoc(view: EditorView, historyConf: Compartment, next: string): void {
  view.dispatch({ effects: historyConf.reconfigure([]) })
  view.dispatch({
    effects: historyConf.reconfigure(history()),
    changes: { from: 0, to: view.state.doc.length, insert: next },
    annotations: [Transaction.addToHistory.of(false), isolateHistory.of('full')],
  })
}

/** 在旧文档留下净零编辑史（+abc 后全删）：内容复原但 done 栈非空（undo 本可执行） */
function netZeroEdits(view: EditorView): void {
  view.dispatch({ changes: { from: 0, to: 0, insert: 'abc' }, selection: { anchor: 3 } })
  view.dispatch({ changes: { from: 0, to: 3, insert: '' }, selection: { anchor: 0 } })
}

describe('CM6 切文档撤销栈清空（X-1）', () => {
  it('同内容切换（两个空白/等文文档）→ undo 不可执行（修复前旧栈残留回灌）', () => {
    const { view, historyConf } = mountEditor('AAA')
    try {
      netZeroEdits(view)
      expect(view.state.doc.toString()).toBe('AAA') // 前置：净零编辑后内容复原
      // 切到内容完全相同的文档 B（'AAA'）——修复前此处无替换事务，旧栈残留
      switchDoc(view, historyConf, 'AAA')
      expect(view.state.doc.toString()).toBe('AAA')
      expect(undo(view)).toBe(false) // undo 栈已清：旧文档逆编辑不可回灌
      expect(view.state.doc.toString()).toBe('AAA') // 内容不被污染
    } finally {
      view.destroy()
    }
  })

  it('不同内容切换 → undo 不可执行（全文替换丢弃旧事件，回归不回退）', () => {
    const { view, historyConf } = mountEditor('AAA')
    try {
      view.dispatch({ changes: { from: 3, to: 3, insert: 'XYZ' }, selection: { anchor: 6 } })
      expect(view.state.doc.toString()).toBe('AAAXYZ')
      switchDoc(view, historyConf, 'BBB')
      expect(view.state.doc.toString()).toBe('BBB')
      expect(undo(view)).toBe(false)
      expect(view.state.doc.toString()).toBe('BBB')
    } finally {
      view.destroy()
    }
  })

  it('切换前 undo 过一次（redo 栈非空）→ 切换后 redo 亦不可回灌（redo 栈同清）', () => {
    const { view, historyConf } = mountEditor('AAA')
    try {
      view.dispatch({ changes: { from: 3, to: 3, insert: 'XYZ' }, selection: { anchor: 6 } })
      expect(undo(view)).toBe(true) // 前置：undo 一次 → redo 栈非空
      expect(view.state.doc.toString()).toBe('AAA')
      switchDoc(view, historyConf, 'CCC')
      expect(view.state.doc.toString()).toBe('CCC')
      expect(redo(view)).toBe(false) // redo 栈已清：旧文档重做不可回灌
      expect(undo(view)).toBe(false)
      expect(view.state.doc.toString()).toBe('CCC')
    } finally {
      view.destroy()
    }
  })

  it('切换后新文档编辑史健康：可编辑、可 undo（字段重挂未被卸残）', () => {
    const { view, historyConf } = mountEditor('AAA')
    try {
      switchDoc(view, historyConf, 'BBB')
      view.dispatch({ changes: { from: 3, to: 3, insert: 'Q' } })
      expect(view.state.doc.toString()).toBe('BBBQ')
      expect(undo(view)).toBe(true)
      expect(view.state.doc.toString()).toBe('BBB')
      expect(redo(view)).toBe(true) // 新文档自身的 redo 正常可用
      expect(view.state.doc.toString()).toBe('BBBQ')
    } finally {
      view.destroy()
    }
  })
})
