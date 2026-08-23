import { onMounted, onUnmounted } from 'vue'
import { useWorkspaceStore } from '../stores/workspace'
import { useDocStore } from '../stores/doc'
import { useUiStore } from '../stores/ui'

// 全局快捷键（在 WorkspaceShell setup 调用，随外壳生命周期挂载/卸载）：
// ⌘S 保存 / ⌘P 命令面板 / Esc 退出专注模式（栏/专注/设置已由系统菜单 accelerator 接管，见 main.ts buildMenu）。
export function useHotkeys(): void {
  const ws = useWorkspaceStore()
  const doc = useDocStore()
  const ui = useUiStore()

  function onKey(e: KeyboardEvent): void {
    // 内嵌层已消费的键让渡：CM 搜索面板等编辑器内 Esc 由 CodeMirror keymap 处理
    //（preventDefault 但事件仍冒泡到 window），不重复消费——关面板的同时不能退出专注
    if (e.defaultPrevented) return
    // Esc 退出专注：任一弹层（命令面板/确认框/设置等）打开时让渡——它们的 Esc 归自身处理
    const overlayOpen =
      ui.paletteOpen || ui.confirmState !== null || ui.settingsOpen || ui.exportOpen || ui.shelfOpen
    if (e.key === 'Escape' && ws.focusMode && !overlayOpen) {
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
      e.preventDefault()
      ui.openPalette()
    }
  }

  onMounted(() => window.addEventListener('keydown', onKey))
  onUnmounted(() => window.removeEventListener('keydown', onKey))
}
