// @vitest-environment happy-dom
/**
 * CmHost 同文档外部全量替换保持完整选区（R50-D1-3）行为族（happy-dom）。
 * （原 cm-external-replace-selection.test.ts 按行为重命名；state 级测试由「复制体 +
 * 源码静态锚」改为直测真实实现——映射逻辑随行为化批抽至
 * src/studio/web-next/src/editor/external-replace.ts 的 mapSelectionForFullReplace，
 * 复制体与防漂移静态锚一并退役，删除 1 条静态锚用例。）
 *
 * 修复前 applyExternalReplace 只存 main.head 单点：活动选区（anchor≠head）与多光标
 * 在外部同步（SSE/refresh）替换后坍缩为单光标。修复后替换前保存完整
 * selection.ranges（各 range anchor/head + mainIndex），逐点按 R62-18「归位原位置」
 * 语义映射（min(pos, v.length) clamp 到 [0, v.length]）重建。
 *
 * 测试分两层（库内既有口径）：
 * - 组件级（真实 CmHost 挂载，cm-composition-guard 同款）：单光标 + 非空单选区
 *   （happy-dom 下 CM6 多光标 view.dispatch 会触发 viewport 测量崩溃——裸 EditorView
 *   零扩展亦复现，属 view 层通用限制与本修复无关，故多光标不走组件级）；
 * - 真实 @codemirror/state 行为级（cm-history-reset 同款）：多光标 ranges 数/位置/
 *   mainIndex 语义，经 mapSelectionForFullReplace 真实单源驱动。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { EditorView } from '@codemirror/view'
import { EditorSelection, EditorState, Transaction } from '@codemirror/state'

vi.mock('../../../src/studio/web-next/src/api/settings', () => ({
  getCompletionNames: vi.fn(async () => ({ characters: [], items: [] })),
}))

import CmHost from '../../../src/studio/web-next/src/editor/CmHost.vue'
import { mapSelectionForFullReplace } from '../../../src/studio/web-next/src/editor/external-replace'

beforeEach(() => {
  setActivePinia(createPinia())
})

// ── 组件级：真实 CmHost 挂载，prop 变化驱动外部替换（与 SSE sync/refresh 同路径）──

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

async function externalReplace(w: ReturnType<typeof mount>, v: string): Promise<void> {
  await w.setProps({ modelValue: v })
  await new Promise((r) => setTimeout(r, 0))
}

describe('R50-D1-3 组件级: 外部全量替换保持选区（happy-dom 可行路径）', () => {
  it('非空选区（anchor≠head）→ 不坍缩，anchor/head 逐点保持（含反向选区方向 + 短文 clamp）', async () => {
    const w = mountHost('AAAABBBB') // 8
    const view = hostView(w)
    // 反向选区：anchor 6 > head 2（修复前坍缩为 anchor=head=min(6, len) 单光标）
    view.dispatch({ selection: EditorSelection.range(6, 2) })
    await externalReplace(w, 'XYZW') // 4
    const r = view.state.selection.main
    expect(r.anchor).toBe(4) // min(6, 4)：越界 clamp 到文末
    expect(r.head).toBe(2) // min(2, 4)：方向语义保持
    expect(r.empty).toBe(false) // 修复点：不坍缩
    // 正向选区 + 长文：原位保持
    view.dispatch({ selection: EditorSelection.range(1, 3) }) // 现文 4 字内取位
    await externalReplace(w, 'AAAABBBBCCCC') // 12
    expect(view.state.selection.main.anchor).toBe(1)
    expect(view.state.selection.main.head).toBe(3)
    expect(view.state.selection.main.empty).toBe(false)
    w.unmount()
  })

  it('单光标旧行为不回归：R62-18 归位语义 min(head, v.length) 逐字保持', async () => {
    const w = mountHost('AAAABBBBCCCC') // 12
    const view = hostView(w)
    view.dispatch({ selection: { anchor: 5 } })
    await externalReplace(w, 'X'.repeat(20)) // 变长：光标停原位 5（不跳文末）
    expect(view.state.selection.main.head).toBe(5)
    await externalReplace(w, 'XY') // 变短：clamp 到新文末
    expect(view.state.selection.main.head).toBe(2)
    expect(view.state.selection.ranges).toHaveLength(1)
    w.unmount()
  })
})

// ── 多光标：真实 @codemirror/state 行为级（经 mapSelectionForFullReplace 真实单源
//    驱动；happy-dom 下多光标 view.dispatch 触发 CM6 viewport 测量崩溃，view 层
//    限制与本修复无关，事务语义核心在 state.update）──────────────────────────

function makeState(doc: string): EditorState {
  return EditorState.create({ doc, extensions: [EditorState.allowMultipleSelections.of(true)] })
}

/** 真实映射单源驱动的替换事务（与 CmHost.applyExternalReplace 同构：全区间替换 +
 *  映射选区 + 不入历史注解） */
function externalReplaceAtState(s: EditorState, v: string): EditorState {
  return s.update({
    changes: { from: 0, to: s.doc.length, insert: v },
    selection: mapSelectionForFullReplace(s.selection, v),
    annotations: Transaction.addToHistory.of(false),
  }).state
}

describe('R50-D1-3 state 级: 多光标经外部全量替换保持', () => {
  it('两光标（main 在后）→ ranges 数/位置/mainIndex 保持（长文）；短文逐点 clamp', () => {
    let s = makeState('AAAABBBBCCCC') // 12
    // 空光标用 cursor() 工厂——本包 6.7.1 的 range(anchor, head) 双参必填（head 无默认值）
    s = s.update({ selection: EditorSelection.create([EditorSelection.cursor(2), EditorSelection.cursor(8)], 1) }).state
    // 新文不短于旧位置：逐点归位（修复前坍缩为单光标 min(mainHead, len)）
    s = externalReplaceAtState(s, 'XXXXYYYYZZZZWWWW') // 16
    expect(s.selection.ranges.map((r) => r.head)).toEqual([2, 8])
    expect(s.selection.mainIndex).toBe(1)
    // 新文更短：逐点 clamp 到新文长（文末语义）
    s = s.update({ selection: EditorSelection.create([EditorSelection.cursor(1), EditorSelection.cursor(9)], 0) }).state
    s = externalReplaceAtState(s, 'XY') // 2
    expect(s.selection.ranges.map((r) => r.head)).toEqual([1, 2])
    expect(s.selection.mainIndex).toBe(0)
  })
})
