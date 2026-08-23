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

/** 探测失败后的重试间隔（ms）。dev 启动竞态：api 慢于 web 就绪时，启动探测失败，
 *  不永久卡「AI 服务未连接」——按间隔重试直到成功。 */
const AI_PROBE_RETRY_MS = 5000

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
      // CC-P1-5：并发 ask 直接顶掉旧弹窗时，旧 Promise 以「取消」结清——
      // 否则首个调用方 await 永久挂起，后续保存/删除逻辑静默丢失
      confirmState.value?.resolve(false)
      confirmState.value = { ...opts, resolve }
    })
  }
  /** ConfirmPrompt 内部调：关闭弹窗 + resolve 调用方。 */
  function resolveConfirm(v: boolean): void {
    const s = confirmState.value
    confirmState.value = null
    s?.resolve(v)
  }
  /** 弹 toast（自动消失；时长按级别分级——低级项（第六轮）：错误 1.8s 读不完就消失，
   *  作者看不到失败原因只能重复操作；成功/信息类保持 1.8s 轻提示）。 */
  function toast(msg: string, kind: ToastItem['kind'] = 'info'): void {
    const id = ++seq
    toasts.value.push({ id, msg, kind })
    setTimeout(() => {
      toasts.value = toasts.value.filter((t) => t.id !== id)
    }, kind === 'error' ? 5000 : 1800)
  }
  /** G4：探测 AI 可达性（启动调一次；失败自动重试，重试成功即停）。 */
  let probeTimer: ReturnType<typeof setTimeout> | null = null
  async function probeAiStatus(): Promise<void> {
    try {
      const s = await getAiStatus()
      aiAvailable.value = s.available
      aiDriver.value = s.driver
      // R-22（第十六轮）：available:false 也走 5s 重试（与网络异常同口径）——后端可达但
      // AI 供应商未配置/未就绪是暂时态，只有 available:true 才停止探测
      if (s.available && probeTimer) {
        clearTimeout(probeTimer)
        probeTimer = null
      }
      if (!s.available && !probeTimer) {
        probeTimer = setTimeout(() => {
          probeTimer = null
          void probeAiStatus()
        }, AI_PROBE_RETRY_MS)
      }
    } catch {
      aiAvailable.value = false
      aiDriver.value = ''
      // API 不可达：定时重试（dev 启动竞态 / 后端重启后自动恢复），成功即停
      if (!probeTimer) {
        probeTimer = setTimeout(() => {
          probeTimer = null
          void probeAiStatus()
        }, AI_PROBE_RETRY_MS)
      }
    }
  }

  /** 全局兜底错误上报（main.ts 的 Vue errorHandler 调，也供其他全局兜底口复用）：
   *  console.error 留痕（原行为）+ 经 toast 通道冒泡给作者——原先只 console.error，
   *  渲染进程异常对作者完全静默。兜底路径自身不得再抛（errorHandler 内二次异常
   *  会被 Vue 吞掉，故 toast 包 try/catch）。 */
  function reportUnhandledError(err: unknown, info = ''): void {
    console.error('[Vue Error]', err, info)
    try {
      const msg = err instanceof Error ? err.message : String(err)
      toast(`发生未处理错误：${msg}`, 'error')
    } catch {
      /* 兜底自身失败只能静默（toast 通道异常时不能再抛） */
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
    ask,
    resolveConfirm,
    toast,
    reportUnhandledError,
  }
})
