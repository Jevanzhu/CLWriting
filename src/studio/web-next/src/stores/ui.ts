import { defineStore } from 'pinia'
import { ref } from 'vue'
import { getAiStatus } from '../api/ai-status'

// UI 全局状态：命令面板 / 设置 / 导出弹窗可见性 + Toast 队列 + AI 可达性（G4 降级）。
export interface ToastItem {
  id: number
  msg: string
  kind: 'info' | 'success' | 'error'
}
let seq = 0

export const useUiStore = defineStore('ui', () => {
  const paletteOpen = ref(false)
  const settingsOpen = ref(false)
  const exportOpen = ref(false)
  const shelfOpen = ref(false)
  // 通用确认弹窗（命令式）：const ok = await ui.ask({ ... })，替代原生 confirm()。
  // 由 ConfirmPrompt.vue 渲染——保持应用内视觉一致，不弹系统原生框。
  const confirmState = ref<{
    title: string
    message: string
    confirmText?: string
    cancelText?: string
    danger?: boolean
    resolve: (v: boolean) => void
  } | null>(null)
  // 通用输入弹窗（命令式）：const v = await ui.prompt({ ... })，替代原生 prompt()。
  // 由 PromptDialog.vue 渲染——收文本输入，与 ConfirmPrompt（二选一）互补。
  const promptState = ref<{
    title: string
    message: string
    placeholder?: string
    defaultValue?: string
    confirmText?: string
    cancelText?: string
    danger?: boolean
    resolve: (v: string | null) => void
  } | null>(null)
  const toasts = ref<ToastItem[]>([])
  // G4：AI 可达性（null=探测中；false=不可达，工作台/开书置灰）
  const aiAvailable = ref<boolean | null>(null)
  const aiDriver = ref('')

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
  function openExport(): void {
    exportOpen.value = true
  }
  function closeExport(): void {
    exportOpen.value = false
  }
  function openShelf(): void {
    shelfOpen.value = true
  }
  function closeShelf(): void {
    shelfOpen.value = false
  }
  /** 命令式确认（替代原生 confirm）。await 返回 true/false；mask 点击视为取消。 */
  function ask(opts: {
    title: string
    message: string
    confirmText?: string
    cancelText?: string
    danger?: boolean
  }): Promise<boolean> {
    return new Promise((resolve) => {
      confirmState.value = { ...opts, resolve }
    })
  }
  /** ConfirmPrompt 内部调：关闭弹窗 + resolve 调用方。 */
  function resolveConfirm(v: boolean): void {
    const s = confirmState.value
    confirmState.value = null
    s?.resolve(v)
  }
  /** 命令式输入（替代原生 prompt）。await 返回 string（确认）/ null（取消）；mask 点击视为取消。 */
  function prompt(opts: {
    title: string
    message: string
    placeholder?: string
    defaultValue?: string
    confirmText?: string
    cancelText?: string
    danger?: boolean
  }): Promise<string | null> {
    return new Promise((resolve) => {
      promptState.value = { ...opts, resolve }
    })
  }
  /** PromptDialog 内部调：关闭弹窗 + resolve 调用方。 */
  function resolvePrompt(v: string | null): void {
    const s = promptState.value
    promptState.value = null
    s?.resolve(v)
  }
  /** 弹 toast（1.8s 自动消失）。 */
  function toast(msg: string, kind: ToastItem['kind'] = 'info'): void {
    const id = ++seq
    toasts.value.push({ id, msg, kind })
    setTimeout(() => {
      toasts.value = toasts.value.filter((t) => t.id !== id)
    }, 1800)
  }
  /** G4：探测 AI 可达性（启动调一次；失败容错 false） */
  async function probeAiStatus(): Promise<void> {
    try {
      const s = await getAiStatus()
      aiAvailable.value = s.available
      aiDriver.value = s.driver
    } catch {
      aiAvailable.value = false
      aiDriver.value = ''
    }
  }

  return {
    paletteOpen,
    settingsOpen,
    exportOpen,
    shelfOpen,
    toasts,
    aiAvailable,
    aiDriver,
    probeAiStatus,
    openPalette,
    closePalette,
    openSettings,
    closeSettings,
    openExport,
    closeExport,
    openShelf,
    closeShelf,
    confirmState,
    promptState,
    ask,
    resolveConfirm,
    prompt,
    resolvePrompt,
    toast,
  }
})
