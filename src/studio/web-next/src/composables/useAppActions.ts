import { useRouter } from 'vue-router'
import { useUiStore } from '../stores/ui'
import { useWorkspaceStore } from '../stores/workspace'
import { useTheme } from './useTheme'

// 应用动作单源：命令面板（CommandPalette）与系统菜单 dispatch 共用此定义。
// 主进程系统菜单（desktop/main.ts buildMenu）跨进程独立硬编码 label/accelerator，
// 但其 click 发出的 actionKey 必须与下方 id 一致——改这里要同步改 main.ts。
export interface AppAction {
  id: string
  label: string
  run: () => void
}

export function useAppActions(): { actions: AppAction[]; dispatch: (key: string) => boolean } {
  const ui = useUiStore()
  const ws = useWorkspaceStore()
  const router = useRouter()
  const { toggle: toggleTheme } = useTheme()

  const actions: AppAction[] = [
    { id: 'settings', label: '打开设置', run: () => ui.openSettings() },
    { id: 'new-book', label: '新建书…', run: () => ui.openShelf() },
    { id: 'export', label: '导出…', run: () => ui.openExport() },
    { id: 'toggle-left', label: '切换左栏', run: () => ws.toggleLeft() },
    { id: 'toggle-right', label: '切换右栏', run: () => ws.toggleRight() },
    { id: 'focus', label: '切换专注模式', run: () => ws.toggleFocus() },
    { id: 'theme', label: '切换亮/暗主题', run: () => toggleTheme() },
    { id: 'shelf', label: '返回书架', run: () => router.push('/shelf') },
  ]

  /** 系统菜单 click / 命令面板 统一入口；命中返回 true。 */
  function dispatch(key: string): boolean {
    const a = actions.find((x) => x.id === key)
    if (!a) return false
    a.run()
    return true
  }

  return { actions, dispatch }
}
