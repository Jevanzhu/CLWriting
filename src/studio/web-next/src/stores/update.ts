// 更新提示 store（自更新链的渲染层状态与文案单源）：顶栏右端角标与设置·关于页
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
import { computed, ref, type Ref } from 'vue'
import { getAppInfo, type AppInfo, type UpdateAttempt, type UpdateInfo } from '../api/app-info'
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
function createUpdatePipeline(hooks: UpdatePipelineHooks): { ensureInit: () => void } {
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

  return { ensureInit }
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
  const { ensureInit } = createUpdatePipeline({
    applyInfo: (info) => {
      version.value = info.version
      latest.value = info.update
      const note = info.updateAttempt ?? null
      // 首见公告一次（结果条是「新版本起不来」场景唯一能活下来的反馈，不能只躺角标）；
      // 服务端读后即删 + 本窗只认首个非空值，重复重取不会重复弹
      if (note && attempt.value === null) {
        attempt.value = note
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
    hasUpdate,
    showAttempt,
    visible,
    canDownload,
    canInstall,
    attemptText,
    progressText,
    statusText,
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
  }
})
