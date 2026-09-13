import { useRouter } from 'vue-router'
import { useUiStore } from '../stores/ui'
import { useWorkspaceStore } from '../stores/workspace'
import { useTheme } from './useTheme'

// 应用动作单源：命令面板（CommandPalette）与系统菜单 dispatch 共用此定义。
// 主进程系统菜单（desktop/main.ts buildMenu）跨进程独立硬编码 label/accelerator，
// 但其 click 发出的 actionKey 必须与下方 id 一致——改这里要同步改 main.ts。
/** 「查找」动作的事件桥名（复审-0913-mac适配 P3-7）。
 *  useAppActions 在 App.vue 顶层实例化，触达不到 EditorView 内部的 CmHost 引用；
 *  经 window CustomEvent 转交——EditorView 挂载期监听并复用右键菜单同一条
 *  openSearch 路径，无活动文档（cmHost 为 null / 视图未挂载）时无人消费即安全
 *  no-op。useHotkeys 的全局 ⌘F 也派发同名事件，双入口同链路不重复弹层。 */
export const APP_FIND_EVENT = 'clw:editor-find'

interface AppAction {
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
    // 复审-0913-mac适配 P3-7：系统菜单「编辑 ▸ 查找…」（desktop/main.ts buildMenu
    // CmdOrCtrl+F）与命令面板共用此 id——经 APP_FIND_EVENT 桥接 EditorView 打开
    // CM 查找面板（无活动文档时安全 no-op，不 toast 不报错）
    { id: 'find', label: '查找…', run: () => window.dispatchEvent(new CustomEvent(APP_FIND_EVENT)) },
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
