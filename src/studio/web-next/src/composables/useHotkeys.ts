import { onMounted, onUnmounted } from 'vue'
import { useWorkspaceStore } from '../stores/workspace'
import { useDocStore } from '../stores/doc'
import { useUiStore } from '../stores/ui'
import { APP_FIND_EVENT } from './useAppActions'

// 全局快捷键（在 WorkspaceShell setup 调用，随外壳生命周期挂载/卸载）：
// ⌘S 保存 / ⌘P 命令面板 / ⌘F 查找 / Esc 退出专注模式
//（栏/专注/设置已由系统菜单 accelerator 接管，见 main.ts buildMenu）。
export function useHotkeys(): void {
  const ws = useWorkspaceStore()
  const doc = useDocStore()
  const ui = useUiStore()

  function onKey(e: KeyboardEvent): void {
    // B-9（第六十轮）：IME 组合期让渡——组合中按 Esc 是收输入法候选框（keyCode 229 为
    // 组合期按键兼容判据），此时退出专注会打断写作流且 preventDefault 与 IME 相争
    if (e.isComposing || e.keyCode === 229) return
    // 内嵌层已消费的键让渡：CM 搜索面板等编辑器内 Esc 由 CodeMirror keymap 处理
    //（preventDefault 但事件仍冒泡到 window），不重复消费——关面板的同时不能退出专注
    if (e.defaultPrevented) return
    // Esc 退出专注：任一弹层（命令面板/确认框/设置等）打开时让渡——它们的 Esc 归自身处理
    // （overlayOpen 单源判据在 ui store，名单口径与所有消费点共用）
    if (e.key === 'Escape' && ws.focusMode && !ui.overlayOpen) {
      e.preventDefault()
      ws.toggleFocus()
      return
    }
    const cmd = e.metaKey || e.ctrlKey
    if (!cmd) return
    const k = e.key.toLowerCase()
    if (k === 's' && !e.shiftKey) {
      e.preventDefault()
      if (ws.activeDocId) void doc.save(ws.activeDocId, 'manual')
    } else if (k === 'p' && !e.shiftKey) {
      // R35-38：任一弹层打开时让渡——面板与弹层同 z-index 时后者后挂载压住前者，
      // 再开命令面板会成被遮住的「隐形面板」（同上方 Esc 的让渡口径）
      if (ui.overlayOpen) return
      e.preventDefault()
      ui.openPalette()
    } else if (k === 'f' && !e.shiftKey) {
      // 复审-0913-mac适配 P3-7：全局 ⌘F 查找——编辑器聚焦时 CM searchKeymap 已消费
      //（preventDefault 后事件仍冒泡，上方 defaultPrevented 守卫已让渡，不会双开面板）；
      // 焦点在外时经 APP_FIND_EVENT 桥接 EditorView 打开查找面板，与系统菜单
      //「查找…」同链路；无活动文档时无人消费即安全 no-op
      e.preventDefault()
      window.dispatchEvent(new CustomEvent(APP_FIND_EVENT))
    }
  }

  onMounted(() => window.addEventListener('keydown', onKey))
  onUnmounted(() => window.removeEventListener('keydown', onKey))
}
