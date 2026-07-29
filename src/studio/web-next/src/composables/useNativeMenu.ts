/**
 * 右键菜单 composable：
 * - 桌面端（Electron）：调用 macOS 原生 Menu（preload → ipcMain → Menu.popup）
 * - 浏览器/dev：回退到自定义 ContextMenu 组件（CSS 模拟）
 *
 * 用法：
 *   const { isNative, menuVisible, menuX, menuY, menuItems, popup, onPopupSelect, onPopupClose }
 *     = useNativeMenu()
 *   function onCtx(e) { popup(items, e.clientX, e.clientY, onSelect) }
 *   // 模板中浏览器回退：
 *   <ContextMenu v-if="!isNative" :visible="menuVisible" ... />
 */
import { ref } from 'vue'
import type { MenuItem } from '../components/ui/ContextMenu.vue'

export function useNativeMenu() {
  const isNative =
    typeof window !== 'undefined' && !!window.clwritingDesktop?.showContextMenu

  // 浏览器回退用的自定义菜单状态
  const menuVisible = ref(false)
  const menuX = ref(0)
  const menuY = ref(0)
  const menuItems = ref<MenuItem[]>([])

  // popup 时绑定的选择回调（浏览器回退用）
  let pendingSelect: ((key: string) => void) | null = null

  /**
   * 弹出右键菜单。
   * @param items  菜单项定义
   * @param x, y   视口坐标
   * @param onSelect 用户选择某项时的回调（取消不调用）
   */
  function popup(items: MenuItem[], x: number, y: number, onSelect: (key: string) => void): void {
    if (isNative) {
      window.clwritingDesktop!.showContextMenu(
        items,
        (key: string | null) => {
          if (key) onSelect(key)
        },
      )
    } else {
      pendingSelect = onSelect
      menuItems.value = items
      menuX.value = x
      menuY.value = y
      menuVisible.value = true
    }
  }

  /** 浏览器回退：ContextMenu @select 回调 */
  function onPopupSelect(key: string): void {
    menuVisible.value = false
    pendingSelect?.(key)
    pendingSelect = null
  }

  /** 浏览器回退：ContextMenu @close 回调 */
  function onPopupClose(): void {
    menuVisible.value = false
    pendingSelect = null
  }

  return { isNative, menuVisible, menuX, menuY, menuItems, popup, onPopupSelect, onPopupClose }
}
