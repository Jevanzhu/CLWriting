import { onMounted, onUnmounted } from 'vue'
import { useWorkspaceStore } from '../stores/workspace'
import { useDocStore } from '../stores/doc'
import { useUiStore } from '../stores/ui'

// 全局快捷键（在 WorkspaceShell setup 调用，随外壳生命周期挂载/卸载）：
// ⌘S 保存 / ⌘P 命令面板（栏/专注/设置已由系统菜单 accelerator 接管，见 main.ts buildMenu）。
export function useHotkeys(): void {
  const ws = useWorkspaceStore()
  const doc = useDocStore()
  const ui = useUiStore()

  function onKey(e: KeyboardEvent): void {
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
