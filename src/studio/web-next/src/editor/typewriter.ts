/**
 * 打字机模式扩展（专注模式启用）：输入后保持当前行垂直居中。
 *
 * B-25（第六十轮）注释如实化：本仓 @codemirror/view 6.43.x 的 updateListeners 在
 * updateState 回到 Idle 之后才调用（dist 实读），listener 内直接 dispatch 并不抛
 * "update in progress"——首版静默失效归因于此系误记。微任务推迟保留为防御性写法
 * （对更早/未来版本语义安全），且取当下光标不映射旧位置的语义不变。
 */
import { EditorView } from '@codemirror/view'
import type { Extension } from '@codemirror/state'

export function typewriterExt(on: boolean): Extension[] {
  if (!on) return []
  return [
    EditorView.updateListener.of((u) => {
      if (!u.docChanged) return
      Promise.resolve().then(() => {
        const v = u.view
        // 视图若已销毁：CM6 update() 对 destroyed 视图提前 return（只更新 state 不碰
        // DOM、不抛错），无需 destroyed 守卫（该字段类型私有，运行时公有）
        const head = v.state.selection.main.head
        v.dispatch({ effects: EditorView.scrollIntoView(head, { y: 'center' }) })
      })
    }),
    // 文档末尾也能居中：内容底部留约半屏滚动余量（打字机标配，否则写到最后一行永远贴底）
    EditorView.theme({ '.cm-content': { paddingBottom: '45vh' } }),
  ]
}

/** 开启打字机时立即把当前行居中（模式切换瞬间对齐）。仅在更新外调用——合法 dispatch。 */
export function centerCursorLine(view: EditorView): void {
  const head = view.state.selection.main.head
  view.dispatch({ effects: EditorView.scrollIntoView(head, { y: 'center' }) })
}
