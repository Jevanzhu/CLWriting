import { defineStore } from 'pinia'
import { computed, ref, watch } from 'vue'
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

// ── J5 窗控压暗：全屏遮罩浓度表（2026-09-04）──
// 各弹窗遮罩浓度不同（设置 .45 / 书架·导出·确认框 .35 / 命令面板 .25），窗控压暗色
// 必须按「当前开着的遮罩」实时合成而非一档写死（写死 .45 时书架 .35 遮罩下窗控深一档
// 即作者反馈的「颜色不统一」）。下列数值与组件 CSS 镜像——j5-overlay-dim.test.ts
// 逐文件读 CSS 锁死防漂移，改遮罩透明度须两处同步。
export const MASK_ALPHA = {
  palette: 0.25, // CommandPalette .palette-mask
  settings: 0.45, // settings-shared.css .modal-mask
  export: 0.35, // ExportDialog .modal-mask
  shelf: 0.35, // ShelfModal .shelf-mask
  confirm: 0.35, // ConfirmPrompt .cp-mask
} as const
export type OverlayKey = keyof typeof MASK_ALPHA
/** 书架子弹窗遮罩（叠在书架遮罩之上）：ConfirmDeleteModal .confirm-overlay .5、
 *  CreateBookModal .create-overlay .3——ShelfModal 私有态，经 setShelfDeepAlpha 上报。 */
export const SHELF_DEEP_ALPHA = { confirmDelete: 0.5, create: 0.3 } as const

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
  // ── 全屏遮罩弹层单源判据（2026-09-04）──
  function overlayStates(): Array<{ key: OverlayKey; open: boolean; alpha: number }> {
    return [
      { key: 'palette', open: paletteOpen.value, alpha: MASK_ALPHA.palette },
      { key: 'settings', open: settingsOpen.value, alpha: MASK_ALPHA.settings },
      { key: 'export', open: exportOpen.value, alpha: MASK_ALPHA.export },
      { key: 'shelf', open: shelfOpen.value, alpha: MASK_ALPHA.shelf },
      { key: 'confirm', open: confirmState.value !== null, alpha: MASK_ALPHA.confirm },
    ]
  }
  /** 「其它遮罩层是否开着」：Esc 让渡判定用（useHotkeys 专注退出 / SettingsModal /
   *  ShelfModal 各自收层）——层自身开着时不应把自己算进让渡名单，传自身 key 剔除。
   *  OR 名单此前在 useHotkeys（Esc 让渡 + Ctrl+P 守卫）与两个弹窗各抄一份，注释写着
   *  「对齐名单口径」纯人肉同步——新增遮罩弹窗漏改一处就出新 bug（R42-30 即此类）。
   *  新增带全屏遮罩的弹窗：状态 ref 建在本 store + 加进 overlayStates 即可，消费点自动跟上。 */
  function overlayOpenExcept(self?: OverlayKey): boolean {
    return overlayStates().some((s) => s.open && s.key !== self)
  }
  /** 任一全屏遮罩弹层开着（palette/设置/导出/书架/确认框）——单源判据。 */
  const overlayOpen = computed(() => overlayOpenExcept())
  /** 书架子弹窗遮罩浓度（ShelfModal 经 setShelfDeepAlpha 上报；只在书架开着时并入
   *  maskAlpha——书架关闭期间残留值不生效，重开书架若子弹窗仍在则继续匹配）。 */
  const shelfDeepAlpha = ref(0)
  function setShelfDeepAlpha(a: number): void {
    shelfDeepAlpha.value = a
  }
  /** 当前有效遮罩浓度：开着的遮罩按 1-Π(1-α) 复合（书架里叠确认框/子弹窗会加深），
   *  0 = 无遮罩。窗控压暗色由 prefs 按该值实时合成（此前 .45 一档写死，.35 遮罩下
   *  窗控偏深一档即作者反馈的「颜色不统一」）。 */
  const maskAlpha = computed(() => {
    const alphas: number[] = []
    for (const s of overlayStates()) if (s.open) alphas.push(s.alpha)
    if (shelfOpen.value && shelfDeepAlpha.value > 0) alphas.push(shelfDeepAlpha.value)
    if (alphas.length === 0) return 0
    return 1 - alphas.reduce((transmit, a) => transmit * (1 - a), 1)
  })
  // J5 窗控遮罩联动（win）：有效遮罩浓度变化 → prefs 按浓度合成压暗色并单拍瞬切
  // （WCO 是 DWM 窗口属性不进网页合成器，逐帧拼过渡=闪烁+延迟，色值与口径见
  //  prefs.setOverlayDimmed）。按浓度而非布尔：弹窗叠开（书架里删书叠确认框）时
  //  浓度复合加深，关上层回到下层浓度，不误还原。原先只有设置弹窗手挂且一档写死，
  //  书架/导出/命令面板/确认框漏联、浓度错档。
  watch(maskAlpha, (a) => {
    usePrefsStore().setOverlayDimmed(a > 0, a)
  })
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
    overlayOpen,
    overlayOpenExcept,
    setShelfDeepAlpha,
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
