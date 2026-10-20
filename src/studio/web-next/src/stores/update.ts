// 更新提示 store（自更新链的渲染层状态与文案单源）：左栏标题条角标与设置·关于页
// 两处渲染面共用同一份状态机与文案，标签/相位只有这里一份。
//
// 状态机：idle → downloading（可取消）→ ready（可安装 / 打开所在文件夹）→ applying
// （主进程带意图退出）→ 退出被取消则回 ready（主进程广播 desktop:update-apply-cancelled）；
// 失败进 failed，主按钮变「重试」（重试即重下，缓存命中时秒回 ready）。
//
// 桥订阅（进度 / 退出被取消）归 store 持有、与窗口同生共死：角标按页挂卸（工作区顶栏
// 与三个独立页标题条各一处），订阅若随组件生命周期走，切页即丢在途进度。
//
// 冷启动竞态：服务端更新检查在起服后 5s 才落结果，界面挂载即取一次必取空——
// 未拿到更新时按 POLL_DELAYS_MS 有界重取，得更新即停（不是长期轮询）。
//
// 「去下载」两条路（保留阶段 53 口径）：桌面版走 IPC openExternal（主进程白名单只
// 放行本项目发布页）；浏览器版无桥 → 降级复制链接（剪贴板不可用时连复制也不提）。
// 取不到版本/接口失败一律静默（更新提示不阻塞应用）。
import { defineStore } from 'pinia'
import { computed, ref, type ComputedRef, type Ref } from 'vue'
import { getAppInfo, type AppInfo, type UpdateAttempt, type UpdateCheckMeta, type UpdateInfo } from '../api/app-info'
import { useUiStore } from './ui'

/** 忽略记忆键（按版本号）：同版本忽略后角标不再出现，出新版再出现 */
export const UPDATE_DISMISS_KEY = 'clw-update-dismissed'

type Phase = 'idle' | 'downloading' | 'ready' | 'applying' | 'failed'

/** 冷启动重取节拍（ms）：服务端检查在起服后 5s 落结果，6s 首探即命中常态；
 *  三次尽则停（服务不可达等场景不无限打点）。 */
const POLL_DELAYS_MS = [6_000, 12_000, 24_000] as const

function loadDismissed(): string[] {
  try {
    const raw = localStorage.getItem(UPDATE_DISMISS_KEY)
    // 脏值容错照先例（StartupNoticeBanner 同款）：非数组不炸 + 元素验 string，
    // 防手改/损坏的 localStorage 把脏值固化进比对面
    const arr = raw ? (JSON.parse(raw) as unknown) : []
    return Array.isArray(arr) ? arr.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

/** 上次更新未完成的原因（机器码 → 人话；文案改动不动主进程） */
const ATTEMPT_REASON_TEXT: Record<UpdateAttempt['reason'], string> = {
  ok: '（已成功）',
  timeout: '旧版本未能按时退出，本次未开始',
  'other-instances': '还有其他书库的窗口在运行，本次未开始',
  'not-writable': '程序所在目录不可写（可能被权限或安全软件拦下）',
  'no-space': '磁盘空间不足',
  'payload-missing': '更新包不在了（可能被清理软件删除）',
  'payload-corrupt': '更新包校验未通过，已丢弃',
  'extract-failed': '更新包解压失败',
  'target-missing': '程序目录缺失',
  'target-locked': '程序目录被占用，未能替换',
  'swap-failed': '替换过程失败，已还原为原版本',
  'relaunch-failed': '已更新但未能自动启动，请手动打开',
  unknown: '未知原因',
}

function fmtSize(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

type UpdateCapability = { canDownload: boolean; canInstall: boolean }
type UpdateProgress = { received: number; total: number | null }

interface UpdatePipelineHooks {
  /** 取回一次 app-info（版本 / 更新 / 结果条一并写入） */
  applyInfo: (info: AppInfo) => void
  /** 仍没拿到更新时继续按节拍重取 */
  needsRefetch: () => boolean
  applyCapability: (c: UpdateCapability) => void
  applyProgress: (p: UpdateProgress) => void
  applyCancelled: () => void
}

/** 取数与桥订阅的时序机制（模块级工厂）：启动位 / 重取计时器 / 节拍与渲染态无耦合，
 *  且 store setup 已到 max-lines-per-function 上限。hooks 只做写入。 */
function createUpdatePipeline(hooks: UpdatePipelineHooks): { ensureInit: () => void; refetch: () => void } {
  let started = false
  let pollTimer: ReturnType<typeof setTimeout> | null = null
  let pollStep = 0

  async function fetchInfo(): Promise<void> {
    try {
      hooks.applyInfo(await getAppInfo())
    } catch {
      /* 服务未起/离线：静默（仍按节拍重取，覆盖起服竞态） */
    }
    if (hooks.needsRefetch()) schedulePoll()
  }

  function schedulePoll(): void {
    if (pollTimer || pollStep >= POLL_DELAYS_MS.length) return
    const delay = POLL_DELAYS_MS[pollStep]!
    pollStep += 1
    pollTimer = setTimeout(() => {
      pollTimer = null
      void fetchInfo()
    }, delay)
  }

  /** 幂等初始化（角标挂载即调；多挂点/多页切换只走一次）。
   *  订阅先于取数：能力面查询失败只降级「去下载」，更新提示不因它消失。 */
  function ensureInit(): void {
    if (started) return
    started = true
    const bridge = window.clwritingDesktop
    if (bridge?.updateCapability) {
      bridge
        .updateCapability()
        .then((c) => {
          hooks.applyCapability(c)
        })
        .catch(() => {
          /* 能力面不可用：降级为「去下载」 */
        })
    }
    bridge?.onUpdateProgress?.((p) => {
      hooks.applyProgress(p)
    })
    bridge?.onUpdateApplyCancelled?.(() => {
      hooks.applyCancelled()
    })
    void fetchInfo()
  }

  return { ensureInit, refetch: (): void => void fetchInfo() }
}

/** 一次性更新告示的合并规则（服务端读后即删）：取到新告示即替换——旧值非空不得成为丢弃
 *  新告示的理由（首个取走者未必是渲染告示的那一页）；按 at 去重，同一条不重复上屏。 */
export function mergeUpdateAttempt(prev: UpdateAttempt | null, note: UpdateAttempt | null): UpdateAttempt | null {
  if (!note) return prev
  return note.at === prev?.at ? prev : note
}

interface UpdateActionsDeps {
  latest: Ref<UpdateInfo | null>
  phase: Ref<Phase>
  progress: Ref<UpdateProgress | null>
  errorText: Ref<string | null>
  copied: Ref<boolean>
}

/** 自更新动作面（模块级工厂）：下载 / 取消 / 安装 / 出口——都经桌面桥，失败一律落
 *  相位或静默降级；相机时序由 createUpdatePipeline 管，这里只管「一次动作」。 */
function createUpdateActions(d: UpdateActionsDeps): {
  startDownload: () => Promise<void>
  cancelDownload: () => Promise<void>
  applyUpdate: () => Promise<void>
  revealZip: () => void
  openDownload: () => Promise<void>
} {
  async function startDownload(): Promise<void> {
    const bridge = window.clwritingDesktop
    const v = d.latest.value?.version
    if (!bridge?.updateDownload || !v) return
    d.phase.value = 'downloading'
    d.progress.value = null
    d.errorText.value = null
    d.copied.value = false
    try {
      const r = await bridge.updateDownload(v)
      if (r.ok) {
        d.phase.value = 'ready'
        d.progress.value = null
        return
      }
      if (r.reason === '已取消下载') {
        d.phase.value = 'idle'
        d.progress.value = null
        return
      }
      d.phase.value = 'failed'
      d.errorText.value = r.reason
    } catch {
      d.phase.value = 'failed'
      d.errorText.value = '下载失败（详见日志）'
    }
  }

  async function cancelDownload(): Promise<void> {
    // 取消后 updateDownload 的 invoke 以 canceled 终态返回，相位在 startDownload 里回落
    try {
      await window.clwritingDesktop?.updateCancel?.()
    } catch {
      /* 取消失败（进程已在退出等）：下载自身仍会落定，不额外提示 */
    }
  }

  async function applyUpdate(): Promise<void> {
    const bridge = window.clwritingDesktop
    const v = d.latest.value?.version
    if (!bridge?.updateApply || !v) return
    d.phase.value = 'applying'
    d.errorText.value = null
    try {
      const r = await bridge.updateApply(v)
      if (!r.ok) {
        d.phase.value = 'failed'
        d.errorText.value = r.reason
      }
      // ok：主进程已带意图退出（应用即将关闭）；若退出被取消会收到 apply-cancelled 广播
    } catch {
      d.phase.value = 'failed'
      d.errorText.value = '更新启动失败（详见日志）'
    }
  }

  function revealZip(): void {
    void window.clwritingDesktop?.updateReveal?.()
  }

  async function openDownload(): Promise<void> {
    const url = d.latest.value?.url
    if (!url) return
    const bridge = window.clwritingDesktop
    if (bridge?.openExternal) {
      const r = await bridge.openExternal(url)
      // 主进程拒绝（白名单外/打开失败）→ 降级复制，不留死按钮
      if (r.ok) return
    }
    try {
      await navigator.clipboard.writeText(url)
      d.copied.value = true
    } catch {
      /* 剪贴板不可用（非安全上下文/无权限）：只留链接文案，不报错 */
    }
  }

  return { startDownload, cancelDownload, applyUpdate, revealZip, openDownload }
}

/** 检查面（状态行文案 + 手动入口）的工厂：只拿一组 ref 与重取回调，不碰 store 本体。 */
interface UpdateCheckDeps {
  version: Ref<string | null>
  latest: Ref<UpdateInfo | null>
  checkMeta: Ref<UpdateCheckMeta | null>
  checkInFlight: Ref<boolean>
  checkNote: Ref<string | null>
  refetch: () => void
}

/**
 * 检查时刻的短文案（今天 14:32 / 昨天 09:10 / 10-18 20:00）——只按本机时区读，跨时不重算：
 * 它服务的是「上次检查离现在多远」这一眼判断，不是时间戳展示。
 */
function fmtCheckedAt(ms: number): string {
  const d = new Date(ms)
  const hhmm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  const today = new Date()
  if (d.toDateString() === today.toDateString()) return `今天 ${hhmm}`
  const yesterday = new Date(today.getTime() - 86_400_000)
  if (d.toDateString() === yesterday.toDateString()) return `昨天 ${hhmm}`
  return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${hhmm}`
}

function createUpdateCheck(d: UpdateCheckDeps): {
  checkStatusText: ComputedRef<string>
  checkNow: () => Promise<void>
} {
  /** 检查面状态行（与 statusText 分工：本条讲「检查这件事」，statusText 讲「更新这件事」）。
   *  无更新时也要有一句——否则「关于」页在无新版时只剩一个孤零零的按钮，用户看不出上次
   *  检查是何时、成没成。 */
  const checkStatusText = computed<string>(() => {
    if (d.checkNote.value !== null) return d.checkNote.value
    if (d.checkInFlight.value || d.checkMeta.value?.state === 'checking') return '正在检查更新…'
    const meta = d.checkMeta.value
    if (meta?.checkedAt == null) return '尚未检查更新'
    const when = fmtCheckedAt(meta.checkedAt)
    if (meta.lastError !== null) return `上次检查未成功（${meta.lastError}）· ${when}`
    if (d.latest.value !== null) return `发现新版本 v${d.latest.value.version} · ${when}`
    return `已是最新版本 v${d.version.value ?? '未知'} · ${when}`
  })

  /** 手动检查一次（按钮入口）。检查在主进程出站，结果不下浮——回执只说「跑了」，正式结论
   *  一律重读端点取，避免两处各自维护一份结果。 */
  async function checkNow(): Promise<void> {
    if (d.checkInFlight.value) return
    d.checkInFlight.value = true
    d.checkNote.value = null
    try {
      const bridge = window.clwritingDesktop
      if (!bridge?.updateCheck) {
        d.checkNote.value = '更新检查不可用'
        return
      }
      const r = await bridge.updateCheck()
      if (!r.ok) {
        d.checkNote.value =
          r.reason === 'tooSoon'
            ? '刚刚检查过，请稍后再试'
            : r.reason === 'checking'
              ? '检查已在进行中'
              : r.reason === 'disabled'
                ? '更新检查已停用'
                : '更新检查不可用'
        return
      }
      d.refetch()
    } catch {
      d.checkNote.value = '更新检查失败'
    } finally {
      d.checkInFlight.value = false
    }
  }

  return { checkStatusText, checkNow }
}
export const useUpdateStore = defineStore('update', () => {
  const version = ref<string | null>(null)
  const latest = ref<UpdateInfo | null>(null)
  const capability = ref<UpdateCapability | null>(null)
  const dismissed = ref<string[]>(loadDismissed())
  const copied = ref(false)
  const phase = ref<Phase>('idle')
  const progress = ref<UpdateProgress | null>(null)
  const errorText = ref<string | null>(null)
  const attempt = ref<UpdateAttempt | null>(null)
  /** 结果条仅本会话内可关（服务端已消费，重开窗口不会再来） */
  const attemptHidden = ref(false)
  /** 检查过程态（服务端落定态）与「点下去到回执之间」的本地在飞态，两者分开：
   *  前者会被别处触发（自动周期）改变，后者只由本页点击置位。 */
  const checkMeta = ref<UpdateCheckMeta | null>(null)
  const checkInFlight = ref(false)
  /** 手动检查的一句回执（「刚刚检查过」「检查已停用」等）；取到新落定态即清 */
  const checkNote = ref<string | null>(null)

  // ── 动作 ──
  // 下载 / 取消 / 安装 / 出口住模块级工厂（见 createUpdateActions）：工厂只拿这一组 ref，
  // 相位切换全发生在 setter 闭包里；下游派生面（primaryAction 等）引用这里解出的动作。
  const { startDownload, cancelDownload, applyUpdate, revealZip, openDownload } = createUpdateActions({
    latest,
    phase,
    progress,
    errorText,
    copied,
  })

  /** 有更新且该版本未被忽略过 */
  const hasUpdate = computed(() => latest.value !== null && !dismissed.value.includes(latest.value.version))
  const showAttempt = computed(() => attempt.value !== null && !attemptHidden.value)
  /** 角标可见（有未忽略的更新，或有一条「上次更新未完成」待看）；与「忽略」无关的
   *  正统入口（设置·关于）不读本判据。 */
  const visible = computed(() => hasUpdate.value || showAttempt.value)
  const canDownload = computed(() => capability.value?.canDownload === true)
  const canInstall = computed(() => capability.value?.canInstall === true)

  /** 上次更新未完成的一句话（机器码人话化；也供角标告示 toast 复用） */
  const attemptText = computed(() => {
    const a = attempt.value
    if (!a) return null
    const what = a.outcome === 'rolled-back' ? '上次更新已还原' : '上次更新未完成'
    return `${what}（v${a.to}）：${ATTEMPT_REASON_TEXT[a.reason] ?? ATTEMPT_REASON_TEXT.unknown}`
  })

  const progressText = computed(() => {
    const p = progress.value
    if (!p) return '正在下载更新包…'
    if (!p.total) return `正在下载更新包 ${fmtSize(p.received)}`
    const pct = Math.min(100, Math.round((p.received / p.total) * 100))
    return `下载中 ${pct}%（${fmtSize(p.received)} / ${fmtSize(p.total)}）`
  })

  /** 状态行（按相位给一句人话；无更新时为 null——「更新提示」类空态不占行） */
  const statusText = computed(() => {
    const v = latest.value
    if (!v) return null
    const cur = `当前 v${version.value ?? '未知'}`
    switch (phase.value) {
      case 'downloading':
        return progressText.value
      case 'ready':
        return canInstall.value
          ? '更新包已就绪 · 重启后自动完成替换'
          : '更新包已就绪 · 自动安装需在 Windows 便携版上进行'
      case 'applying':
        return '正在退出并更新…（若退出被取消会回到上一步）'
      case 'failed':
        return errorText.value ?? '更新失败'
      default:
        return canDownload.value
          ? `${cur} · 可在此下载更新${v.asset?.size ? `（约 ${fmtSize(v.asset.size)}）` : ''}`
          : `${cur} · 不会自动下载，点「去下载」到发布页`
    }
  })

  /** 主按钮：按相位切换（无下载能力的形态不渲染它，只留「去下载」） */
  const primaryAction = computed<{ label: string; run: () => void } | null>(() => {
    switch (phase.value) {
      case 'downloading':
        return { label: '取消', run: () => void cancelDownload() }
      case 'ready':
        return canInstall.value
          ? { label: '立即重启并更新', run: () => void applyUpdate() }
          : { label: '打开所在文件夹', run: revealZip }
      case 'failed':
        return { label: '重试', run: () => void startDownload() }
      case 'applying':
        return null
      default:
        return canDownload.value && latest.value ? { label: '下载并更新', run: () => void startDownload() } : null
    }
  })

  /** 「去下载」链接位（下载/应用在途时不出——那是当前动作，不是出口） */
  const showDownloadLink = computed(
    () => latest.value !== null && phase.value !== 'applying' && phase.value !== 'downloading',
  )
  /** 「忽略此版本」位（就绪/应用态不出：包已就位，忽略语义只剩误导） */
  const showDismiss = computed(() => hasUpdate.value && (phase.value === 'idle' || phase.value === 'failed'))

  // ── 初始化（取数与桥订阅的时序机制住模块级工厂，见 createUpdatePipeline）──
  const { ensureInit, refetch } = createUpdatePipeline({
    applyInfo: (info) => {
      version.value = info.version
      latest.value = info.update
      checkMeta.value = info.updateCheck ?? null
      // 一次性信箱（服务端读后即删）取到即上屏——合并规则见 mergeUpdateAttempt
      const merged = mergeUpdateAttempt(attempt.value, info.updateAttempt ?? null)
      if (merged !== attempt.value) {
        attempt.value = merged
        useUiStore().toast(attemptText.value ?? '上次更新未完成', 'warning')
      }
    },
    needsRefetch: () => latest.value === null,
    applyCapability: (c) => {
      capability.value = c
    },
    applyProgress: (p) => {
      progress.value = p
    },
    applyCancelled: () => {
      // 退出被取消（flush 冲突/失败确认）→ 主进程丢弃了更新意图，界面回到「已就绪」
      phase.value = 'ready'
      errorText.value = null
    },
  })

  // 检查面（状态行文案 + 手动入口）住模块级工厂：setup 本体已贴 max-lines-per-function
  // 上限，加在这一层会被 lint 拦；与 createUpdateActions / createUpdatePipeline 同口径。
  const { checkStatusText, checkNow } = createUpdateCheck({
    version,
    latest,
    checkMeta,
    checkInFlight,
    checkNote,
    refetch,
  })
  /** 忽略该版本（角标不再出现，出新版再出现）；「去下载」等出口不受影响 */
  function dismissUpdate(): void {
    const v = latest.value?.version
    if (!v) return
    dismissed.value = [...dismissed.value, v]
    try {
      localStorage.setItem(UPDATE_DISMISS_KEY, JSON.stringify(dismissed.value))
    } catch {
      /* localStorage 不可用：本次会话内忽略即静默 */
    }
  }

  /** 关掉「上次更新未完成」条（本会话内不再显示） */
  function hideAttempt(): void {
    attemptHidden.value = true
  }

  /** 弹层重新打开时复位「链接已复制」（上一轮的复制回执不跨次） */
  function resetCopied(): void {
    copied.value = false
  }

  return {
    version,
    latest,
    capability,
    dismissed,
    copied,
    phase,
    progress,
    errorText,
    attempt,
    attemptHidden,
    checkMeta,
    checkInFlight,
    checkNote,
    hasUpdate,
    showAttempt,
    visible,
    canDownload,
    canInstall,
    attemptText,
    progressText,
    statusText,
    checkStatusText,
    primaryAction,
    showDownloadLink,
    showDismiss,
    ensureInit,
    startDownload,
    cancelDownload,
    applyUpdate,
    revealZip,
    openDownload,
    dismissUpdate,
    hideAttempt,
    resetCopied,
    checkNow,
  }
})
