/**
 * CmHost 对外暴露面（defineExpose）的类型单源。
 *
 * 为什么独立成 .ts：父组件 EditorView 经 `.vue` 模块取具名类型导出时，类型化 lint 程序
 * 解析不到 SFC 模块（整个模块落 error 类型），cmHost 句柄的每次取用都被判成
 * unsafe-member-access 一族——句柄真类型被抑制表掩盖，改动漏暴露也不会报红。类型移入
 * .ts 模块后两侧取同一份声明：CmHost.vue 的 `defineExpose<CmHostHandle>(…)` 反向钉住
 * 实现面（漏暴露/多暴露/签名不符即编译期报错），EditorView 的 ref 标注与之一致。
 */
export interface CmHostHandle {
  /** 在当前光标处插入文本（无 view 时为 no-op） */
  insertText: (t: string) => void
  /** 当前选区文本（无选区/无 view 时为空串） */
  getSelection: () => string
  hasSelection: () => boolean
  /** 光标偏移（无 view 时为 null） */
  getCursorOffset: () => number | null
  clipboardCut: () => Promise<void>
  clipboardCopy: () => Promise<void>
  clipboardPaste: () => Promise<void>
  selectAll: () => void
  undoAction: () => void
  redoAction: () => void
  openSearch: () => void
}
