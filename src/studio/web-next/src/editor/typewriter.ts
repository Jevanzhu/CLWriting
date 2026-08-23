/**
 * 打字机模式扩展（专注模式启用）：输入后保持当前行垂直居中。
 *
 * CM6 铁律：updateListener 在「更新进行中」被调用，其中直接 view.dispatch 会抛
 * "Calls to EditorView.update are not allowed while an update is in progress"，
 * 且异常被 CM 的 listener try/catch 吞成控制台日志——首版打字机静默失效的根因。
 * 正确姿势：微任务推迟到本轮 update 完成后再 dispatch，且取当下光标（不映射旧位置）。
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
