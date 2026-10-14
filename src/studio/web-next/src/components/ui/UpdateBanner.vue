<script setup lang="ts">
// 更新提示横幅（阶段 53 立、阶段 55 扩自更新链）：有新正式版时提示，能应用内更新的
// 形态直接下载 + 重启兑现，其余形态保留「去下载」。
//
// 与 StartupNoticeBanner 的区别在「记忆键」：通告按条指纹（kind@ts）记忆，本横幅按
// **版本号**记忆——同一版本关掉不再弹，出新版（下次检查拿到新版本号）再弹。
//
// 状态机（阶段 55）：idle → downloading（可取消）→ ready（可安装 / 打开所在文件夹）
// → applying（主进程带意图退出）→ 退出被取消则回 ready（主进程广播
// desktop:update-apply-cancelled）；失败进 failed，主按钮变「重试」（重试即重下，
// 缓存命中时秒回 ready）。
//
// 「去下载」两条路（保留阶段 53 口径）：桌面版走 IPC openExternal（主进程白名单只放行
// 本项目发布页）；浏览器版无桥 → 降级复制链接（navigator.clipboard 不可用时连复制也
// 不提，只留提示）。取不到版本/接口失败一律静默不显示（设计 §3.3 的静默口径同款）。
//
// 「上次更新未完成」条（阶段 55）：服务端结果条（更新助手写在新进程起服前）读一次即
// 删，本组件挂载时取到就显示——它是「新版本起不来」场景下唯一能活下来的反馈。
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { Download, X } from 'lucide-vue-next'
import { getAppInfo, type UpdateAttempt, type UpdateInfo } from '../../api/app-info'

const DISMISS_KEY = 'clw-update-dismissed'

function loadDismissed(): string[] {
  try {
    const raw = localStorage.getItem(DISMISS_KEY)
    // 脏值容错照先例（StartupNoticeBanner 同款）：非数组不炸 + 元素验 string，
    // 防手改/损坏的 localStorage 把脏值固化进比对面
    const arr = raw ? (JSON.parse(raw) as unknown) : []
    return Array.isArray(arr) ? arr.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

type Phase = 'idle' | 'downloading' | 'ready' | 'applying' | 'failed'

const currentVersion = ref<string | null>(null)
const latest = ref<UpdateInfo | null>(null)
const capability = ref<{ canDownload: boolean; canInstall: boolean } | null>(null)
const dismissed = ref<string[]>(loadDismissed())
const copied = ref(false)
const phase = ref<Phase>('idle')
const progress = ref<{ received: number; total: number | null } | null>(null)
const errorText = ref<string | null>(null)
const attempt = ref<UpdateAttempt | null>(null)
/** 结果条仅本会话内可关（服务端已消费，重开窗口不会再来） */
const attemptHidden = ref(false)

/** 有更新且该版本未被关闭过；或有一条「上次更新未完成」待看 */
const visible = computed(
  () =>
    (latest.value !== null && !dismissed.value.includes(latest.value.version)) ||
    (attempt.value !== null && !attemptHidden.value),
)
const canDownload = computed(() => capability.value?.canDownload === true)
const canInstallFully = computed(() => capability.value?.canInstall === true)

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

const attemptText = computed(() => {
  const a = attempt.value
  if (!a) return null
  const what = a.outcome === 'rolled-back' ? '上次更新已还原' : '上次更新未完成'
  return `${what}（v${a.to}）：${ATTEMPT_REASON_TEXT[a.reason] ?? ATTEMPT_REASON_TEXT.unknown}`
})

function fmtSize(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

const progressText = computed(() => {
  const p = progress.value
  if (!p) return '正在下载更新包…'
  if (!p.total) return `正在下载更新包 ${fmtSize(p.received)}`
  const pct = Math.min(100, Math.round((p.received / p.total) * 100))
  return `下载中 ${pct}%（${fmtSize(p.received)} / ${fmtSize(p.total)}）`
})

const subText = computed(() => {
  const v = latest.value
  if (!v) return null
  const cur = `当前 v${currentVersion.value ?? '未知'}`
  switch (phase.value) {
    case 'downloading':
      return progressText.value
    case 'ready':
      return canInstallFully.value
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

let offProgress: (() => void) | null = null
let offCancelled: (() => void) | null = null

onMounted(async () => {
  const bridge = window.clwritingDesktop
  // 能力面独立取（取不到就只留「去下载」降级——更新提示不该因能力查询失败而消失）
  if (bridge?.updateCapability) {
    try {
      capability.value = await bridge.updateCapability()
    } catch {
      /* 能力面不可用：降级为「去下载」 */
    }
  }
  if (bridge?.onUpdateProgress) {
    offProgress = bridge.onUpdateProgress((p) => {
      progress.value = p
    })
  }
  if (bridge?.onUpdateApplyCancelled) {
    // 退出被取消（flush 冲突/失败确认）→ 主进程丢弃了更新意图，界面回到「已就绪」
    offCancelled = bridge.onUpdateApplyCancelled(() => {
      phase.value = 'ready'
      errorText.value = null
    })
  }
  try {
    const info = await getAppInfo()
    currentVersion.value = info.version
    latest.value = info.update
    attempt.value = info.updateAttempt ?? null
  } catch {
    /* 服务未起/离线：静默不显示（更新提示不阻塞应用） */
  }
})

onUnmounted(() => {
  offProgress?.()
  offCancelled?.()
})

async function startDownload(): Promise<void> {
  const bridge = window.clwritingDesktop
  const version = latest.value?.version
  if (!bridge?.updateDownload || !version) return
  phase.value = 'downloading'
  progress.value = null
  errorText.value = null
  try {
    const r = await bridge.updateDownload(version)
    if (r.ok) {
      phase.value = 'ready'
      progress.value = null
      return
    }
    if (r.reason === '已取消下载') {
      phase.value = 'idle'
      progress.value = null
      return
    }
    phase.value = 'failed'
    errorText.value = r.reason
  } catch {
    phase.value = 'failed'
    errorText.value = '下载失败（详见日志）'
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
  const version = latest.value?.version
  if (!bridge?.updateApply || !version) return
  phase.value = 'applying'
  errorText.value = null
  try {
    const r = await bridge.updateApply(version)
    if (!r.ok) {
      phase.value = 'failed'
      errorText.value = r.reason
    }
    // ok：主进程已带意图退出（应用即将关闭）；若退出被取消会收到 apply-cancelled 广播
  } catch {
    phase.value = 'failed'
    errorText.value = '更新启动失败（详见日志）'
  }
}

function revealZip(): void {
  void window.clwritingDesktop?.updateReveal?.()
}

async function openDownload(): Promise<void> {
  const url = latest.value?.url
  if (!url) return
  const bridge = window.clwritingDesktop
  if (bridge?.openExternal) {
    const r = await bridge.openExternal(url)
    // 主进程拒绝（白名单外/打开失败）→ 降级复制，不留死按钮
    if (r.ok) return
  }
  try {
    await navigator.clipboard.writeText(url)
    copied.value = true
  } catch {
    /* 剪贴板不可用（非安全上下文/无权限）：只留链接文案，不报错 */
  }
}

function dismiss(): void {
  const v = latest.value?.version
  if (v) {
    dismissed.value = [...dismissed.value, v]
    try {
      localStorage.setItem(DISMISS_KEY, JSON.stringify(dismissed.value))
    } catch {
      /* localStorage 不可用：本次会话内关闭即静默 */
    }
  }
  // 结果条（可能没有更新可用，只有这一条）：本会话关掉
  attemptHidden.value = true
}

/** 主按钮：按相位切换（无下载能力的形态不渲染它，只留「去下载」） */
const primary = computed<{ label: string; run: () => void } | null>(() => {
  switch (phase.value) {
    case 'downloading':
      return { label: '取消', run: () => void cancelDownload() }
    case 'ready':
      return canInstallFully.value
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
</script>

<template>
  <div v-if="visible" class="ub-banner" role="status">
    <Download :size="18" class="ub-icon" />
    <div class="ub-body">
      <p v-if="latest" class="ub-title">有新版本 v{{ latest.version }}</p>
      <p v-else class="ub-title">更新提示</p>
      <p v-if="subText" class="ub-sub">{{ subText }}</p>
      <p v-if="attemptText" class="ub-attempt">{{ attemptText }}</p>
    </div>
    <button v-if="primary" class="ub-primary" @click="primary.run()">
      {{ primary.label }}
    </button>
    <button v-if="latest && phase !== 'applying' && phase !== 'downloading'" class="ub-open" @click="openDownload">
      {{ copied ? '链接已复制' : '去下载' }}
    </button>
    <button class="ub-close" title="关闭（该版本不再提示，出新版会再提示）" @click="dismiss">
      <X :size="16" />
    </button>
  </div>
</template>

<style scoped>
.ub-banner {
  display: flex;
  align-items: center;
  gap: var(--size-4-2);
  margin: var(--size-4-2) var(--size-4-3);
  padding: var(--size-4-2) var(--size-4-3);
  border: 1px solid var(--text-accent, #4f8cff);
  border-radius: var(--radius-s);
  background: var(--background-secondary);
}
.ub-icon {
  flex: none;
  color: var(--text-accent, #4f8cff);
}
.ub-body {
  flex: 1;
  min-width: 0;
}
.ub-title {
  font-size: var(--font-size-m);
  font-weight: 600;
  color: var(--text-normal);
}
.ub-sub {
  margin-top: 2px;
  font-size: var(--font-size-s);
  color: var(--text-muted);
}
.ub-attempt {
  margin-top: 2px;
  font-size: var(--font-size-s);
  color: var(--text-warning);
}
.ub-open {
  flex: none;
  padding: 4px 10px;
  font-size: var(--font-size-s);
  border: 1px solid var(--text-accent, #4f8cff);
  border-radius: var(--radius-s);
  background: var(--background-primary);
  color: var(--text-accent, #4f8cff);
  cursor: pointer;
}
.ub-open:hover {
  background: var(--background-modifier-hover);
}
.ub-primary {
  flex: none;
  padding: 4px 10px;
  font-size: var(--font-size-s);
  border: 1px solid var(--text-accent, #4f8cff);
  border-radius: var(--radius-s);
  background: var(--text-accent, #4f8cff);
  color: var(--text-on-accent, #fff);
  cursor: pointer;
}
.ub-primary:hover {
  filter: brightness(1.08);
}
.ub-close {
  flex: none;
  display: flex;
  align-items: center;
  padding: 4px 6px;
  border: none;
  border-radius: var(--radius-s);
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
}
.ub-close:hover {
  background: var(--background-modifier-hover);
}
</style>
