import { defineStore } from 'pinia'
import { ref } from 'vue'
import { getAiStatus } from '../api/ai-status'
import { usePrefsStore } from './prefs'

// UI 全局状态：命令面板 / 设置 / 导出弹窗可见性 + Toast 队列 + AI 可达性（G4 降级）。
export interface ToastItem {
  id: number
  msg: string
  // R30-7（三十轮）：补 'warning' 级——「已落盘但未完全生效」类半失败提示（如恢复后
  // 编辑器刷新失败）语义介于 info 与 error 之间，错用 error 会夸大、错用 info 会淡化
  kind: 'info' | 'success' | 'error' | 'warning'
}
let seq = 0

/** E-5（二十九轮）：探测失败重试间隔——指数退避（5s 起步 ×2 封顶 60s）。原 5s 固定
 *  轮询在 AI 长期不可达时永久打点（无退避上限）；available:true 成功即停并复位阶数。 */
const AI_PROBE_BASE_MS = 5_000
const AI_PROBE_MAX_MS = 60_000

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
    // J5 win：弹窗遮罩压暗页面时同步压暗系统窗控条（否则亮块钉在暗页面上）
    usePrefsStore().setOverlayDimmed(true)
  }
  function closeSettings(): void {
    settingsOpen.value = false
    usePrefsStore().setOverlayDimmed(false)
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
  /** R32-34（三十二轮）：toast 上限——循环失败（AI 轮询报错等）此前逐条无界堆叠遮屏 */
  const TOAST_MAX = 5
  /** R32-34：消失计时器登记表（同文案合并重置计时用；dismiss 时同步清理） */
  const toastTimers = new Map<number, ReturnType<typeof setTimeout>>()
  function armToastTimer(id: number, kind: ToastItem['kind']): void {
    toastTimers.set(
      id,
      setTimeout(() => dismissToast(id), kind === 'error' || kind === 'warning' ? 5000 : 1800), // R30-7（三十轮）：warning 需作者行动（如手动重载），时长对齐 error 档
    )
  }
  /** R32-34：关闭单条 toast（点击关闭 + 计时到期共用出口） */
  function dismissToast(id: number): void {
    const timer = toastTimers.get(id)
    if (timer) {
      clearTimeout(timer)
      toastTimers.delete(id)
    }
    toasts.value = toasts.value.filter((t) => t.id !== id)
  }
  /** 弹 toast（自动消失；时长按级别分级——低级项（第六轮）：错误 1.8s 读不完就消失，
   *  作者看不到失败原因只能重复操作。R76-35（二十四轮 E 域）：注释校正——实际代码
   *  error 5000ms / 成功与信息类 1800ms，旧注释「错误 1.8s」与实现相悖，误导后续维护）。
   *  R32-34：同文案同级别合并（重置既有条目消失计时，循环失败只刷新一条不堆叠）+
   *  上限 TOAST_MAX（挤掉最旧）。 */
  function toast(msg: string, kind: ToastItem['kind'] = 'info'): void {
    const existing = toasts.value.find((t) => t.msg === msg && t.kind === kind)
    if (existing) {
      const timer = toastTimers.get(existing.id)
      if (timer) clearTimeout(timer)
      armToastTimer(existing.id, kind)
      return
    }
    if (toasts.value.length >= TOAST_MAX) dismissToast(toasts.value[0]!.id)
    const id = ++seq
    toasts.value = [...toasts.value, { id, msg, kind }]
    armToastTimer(id, kind)
  }
  /** G4：探测 AI 可达性（启动调一次；失败按指数退避自动重试，available:true 成功即停）。 */
  let probeTimer: ReturnType<typeof setTimeout> | null = null
  let probeStep = 0 // E-5：退避阶数（成功复位；每次失败 +1 → 5s→10s→…→60s 封顶）
  function scheduleProbeRetry(): void {
    if (probeTimer) return
    probeStep += 1
    const delay = Math.min(AI_PROBE_BASE_MS * 2 ** (probeStep - 1), AI_PROBE_MAX_MS)
    probeTimer = setTimeout(() => {
      probeTimer = null
      void probeAiStatus()
    }, delay)
  }
  async function probeAiStatus(): Promise<void> {
    try {
      const s = await getAiStatus()
      aiAvailable.value = s.available
      aiDriver.value = s.driver
      // R-22（第十六轮）：available:false 也重试（与网络异常同口径）——后端可达但
      // AI 供应商未配置/未就绪是暂时态，只有 available:true 才停止探测
      if (s.available) {
        probeStep = 0 // E-5：成功复位退避阶数（下次失败重新从 5s 起步）
        if (probeTimer) {
          clearTimeout(probeTimer)
          probeTimer = null
        }
        return
      }
      scheduleProbeRetry()
    } catch {
      aiAvailable.value = false
      aiDriver.value = ''
      // API 不可达：退避重试（dev 启动竞态 / 后端重启后自动恢复），成功即停
      scheduleProbeRetry()
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
    dismissToast,
    reportUnhandledError,
  }
})
