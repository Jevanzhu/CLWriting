import { defineStore } from 'pinia'
import { ref } from 'vue'

// UI 全局状态：命令面板 / 设置弹窗可见性 + Toast 队列（细案 T2.4）。
export interface ToastItem {
  id: number
  msg: string
  kind: 'info' | 'success' | 'error'
}
let seq = 0

export const useUiStore = defineStore('ui', () => {
  const paletteOpen = ref(false)
  const settingsOpen = ref(false)
  const toasts = ref<ToastItem[]>([])

  function openPalette(): void {
    paletteOpen.value = true
  }
  function closePalette(): void {
    paletteOpen.value = false
  }
  function openSettings(): void {
    settingsOpen.value = true
  }
  function closeSettings(): void {
    settingsOpen.value = false
  }
  /** 弹 toast（1.8s 自动消失）。 */
  function toast(msg: string, kind: ToastItem['kind'] = 'info'): void {
    const id = ++seq
    toasts.value.push({ id, msg, kind })
    setTimeout(() => {
      toasts.value = toasts.value.filter((t) => t.id !== id)
    }, 1800)
  }

  return {
    paletteOpen,
    settingsOpen,
    toasts,
    openPalette,
    closePalette,
    openSettings,
    closeSettings,
    toast,
  }
})
