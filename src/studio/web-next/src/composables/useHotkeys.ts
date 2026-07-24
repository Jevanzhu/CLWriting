import { onMounted, onUnmounted } from 'vue'
import { useWorkspaceStore } from '../stores/workspace'
import { useDocStore } from '../stores/doc'
import { useUiStore } from '../stores/ui'

// 全局快捷键（在 WorkspaceShell setup 调用，随外壳生命周期挂载/卸载）：
// ⌘B 左栏 / ⌘⇧B 右栏 / ⌘⇧F 专注 / ⌘S 保存 / ⌘W 关 tab / ⌘P 命令面板 / ⌘, 设置。
export function useHotkeys(): void {
  const ws = useWorkspaceStore()
  const doc = useDocStore()
  const ui = useUiStore()

  function onKey(e: KeyboardEvent): void {
    const cmd = e.metaKey || e.ctrlKey
    if (!cmd) return
    const k = e.key.toLowerCase()
    if (k === 'b' && !e.shiftKey) {
      e.preventDefault()
      ws.toggleLeft()
    } else if (k === 'b' && e.shiftKey) {
      e.preventDefault()
      ws.toggleRight()
    } else if (k === 'f' && e.shiftKey) {
      e.preventDefault()
      ws.toggleFocus()
    } else if (k === 's' && !e.shiftKey) {
      e.preventDefault()
      if (ws.activeDocId) void doc.save(ws.activeDocId, 'manual')
    } else if (k === 'w' && !e.shiftKey) {
      e.preventDefault()
      if (ws.activeTabId) ws.requestClose(ws.activeTabId)
    } else if (k === 'p' && !e.shiftKey) {
      e.preventDefault()
      ui.openPalette()
    } else if (k === ',') {
      e.preventDefault()
      ui.openSettings()
    }
  }

  onMounted(() => window.addEventListener('keydown', onKey))
  onUnmounted(() => window.removeEventListener('keydown', onKey))
}
