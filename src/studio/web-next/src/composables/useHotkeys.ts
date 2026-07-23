import { onMounted, onUnmounted } from 'vue'
import { useWorkspaceStore } from '../stores/workspace'

// 全局快捷键（在 WorkspaceShell setup 调用，随外壳生命周期挂载/卸载）：
// ⌘B 左栏 / ⌘⇧B 右栏 / ⌘⇧F 专注。⌘S（保存）/ ⌘P（命令面板）等随对应阶段加入。
export function useHotkeys(): void {
  const ws = useWorkspaceStore()

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
    }
  }

  onMounted(() => window.addEventListener('keydown', onKey))
  onUnmounted(() => window.removeEventListener('keydown', onKey))
}
