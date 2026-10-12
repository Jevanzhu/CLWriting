/**
 * 主窗退出链与生命周期监听。
 *
 * 退出编排（close/session-end/before-quit 三链的相位、互斥、幂等与顺序）收敛在本文件
 * 顶部的显式状态机（exitChain + isLegalExitTransition + transition）；对外只读面：
 * isAppTearingDown（serverManager 退出探测接线）；窗口引用经 wins（windows.ts）；
 * 切库回滚/relaunch 意图经 workdir-controller。
 */
import { app, dialog, type BrowserWindow } from 'electron'
import { log } from '../log/index.js'
import { raceWithTimeout } from './workdir-store.js'
import { guardClosedCleanup, saveWinState, wins } from './windows.js'
import { armPendingRelaunchIfAny, discardPendingRelaunch, rollbackCancelledSwitch } from './workdir-controller.js'

// ── 退出编排（显式状态机：相位 × OS 停机面 + 待汇入退出请求）──
// 旧形态：5 个模块级可变旗（sessionEnding / appTearingDown / closeFlushInFlight /
// quitFlushInFlight / quitDuringCloseFlush）+ quit 链私有标记 quitViaShutdown，三条链
// （close / session-end / before-quit）各自读写；哪些组合可达、哪两旗互斥、旗何时复位，
// 正确性只写在各点注释的正确性证明里。现收敛为：唯一可变状态源 exitChain + 派生读数
// （isExitPassthrough / isCloseFlushInFlight / isQuitChainEngaged / isQuitReleased …）+
// 转移表 isLegalExitTransition + 私有转移点 transition（对齐 server-manager 的范式）。
// 行为逐位不变：谁先谁后 / 超时 / 幂等 / 二次触发 / 异常路径全部保持。

/**
 * 退出编排相位——同一进程同时只处于一个：
 * - 'idle'         无链在途、未过不可回头点
 * - 'close-flush'  close 拦截链在途（渲染层 flush + 冲突/失败确认）——原 closeFlushInFlight
 * - 'quit-flush'   before-quit 链在途——原 quitFlushInFlight 的链内段
 * - 'tearing-down' 已过不可回头点——原 appTearingDown：停机指令在途 / 收口 destroy 全窗 /
 *                  session-end 级联直通；置位后不可回退
 * - 'releasing'    收口放行——原 quitViaShutdown：finally 的 app.quit 直通
 * 合入形态：session-end 级联可在 close 链仍在途时置 T（相位直接到 'tearing-down'）——
 * 原 closeFlushInFlight 彼时仍为真，但其两个读点（close 拦截的互斥闸、before-quit 的
 * 汇入闸）都被更前的直通闸（sessionEnding/appTearingDown，见 isExitPassthrough）命中而
 * 不可达，故合并不改变任何对外行为；close 链自身收尾照旧落定（幂等，不回退相位）。
 */
export type ExitPhase = 'idle' | 'close-flush' | 'quit-flush' | 'tearing-down' | 'releasing'

/** OS 停机面——'ending' = session-end（OS 关机/注销）在途：close 直关放行、原生确认框
 *  跳过（无人可答）、观察窗到点且真退出链未接管时复位。与相位正交（任何相位都可置位）。 */
export type OsShutdownMode = 'none' | 'ending'

/** 转移事件——退出编排的每次状态变更都以一者表达（调用点见三条链）。
 *  session-end 观察窗定时器的清/重臂是资源句柄操作（非状态迁移），不经本表。 */
export type ExitEvent =
  | 'close-flush-open' // close 链开工（渲染层 flush 在途）
  | 'close-flush-settle' // close 链收尾（destroy 收口 / 窗口先毁的退化收尾）
  | 'close-flush-cancel' // 作者取消关窗（同时作废待汇入的退出请求）
  | 'quit-defer' // close flush 在途时到达的退出请求（拦下并记待汇入）
  | 'quit-flush-open' // quit 链开工（渲染层 flush 在途）
  | 'quit-flush-cancel' // 作者取消退出（应用原样保留）
  | 'tear-down' // 过不可回头点（原 appTearingDown 置位）
  | 'quit-release' // 收口放行（原 quitViaShutdown 置位；调用方随即 app.quit）
  | 'os-shutdown-begin' // session-end 到达（OS 收尾在途）
  | 'os-shutdown-recover' // 观察窗到点进程仍存活（关机被取消/被拒）→ 复位停机面

/** 退出编排读数快照（转移表回归与诊断的观测面；deferredQuit 语义见 ExitChainState） */
export interface ExitChainSnapshot {
  phase: ExitPhase
  osShutdown: OsShutdownMode
  /** close flush 在途时到达的退出请求是否待汇入（由 close 链收尾统一 app.quit） */
  deferredQuit: boolean
}

/** 状态机唯一可变真相源（模块级 = 每模块实例一份——main 经 resetModules 重载时随实例
 *  隔离，与拆分前 5 个模块级旗同粒度）。除 transition 与 takeDeferredQuitRequest
 *  （正交数据，见其注）外不得改写本对象。 */
interface ExitChainState extends ExitChainSnapshot {
  /** session-end 观察窗定时器（与停机面同生命周期：重臂清旧、到点摘除） */
  osRecoveryTimer: ReturnType<typeof setTimeout> | null
}

const exitChain: ExitChainState = {
  phase: 'idle',
  osShutdown: 'none',
  deferredQuit: false,
  osRecoveryTimer: null,
}

/**
 * 转移表（机器可读形态，与 transition 的 switch 一一对应）：事件 × 前置（相位, 停机面）
 * → 是否合法。非法不是静默返回：transition 记 error 留痕并拒绝（状态不变）。
 * 本表外露供转移矩阵测试直测——表的边界即状态机契约。
 */
export function isLegalExitTransition(ev: ExitEvent, phase: ExitPhase, os: OsShutdownMode): boolean {
  switch (ev) {
    // 开工：只有空闲相位可开（两链互斥由相位本身承担——入口的在途闸先拦下非 idle 形态）。
    // OS 停机在途时 close 走直关放行、before-quit 走级联直通，两链都不会开工
    case 'close-flush-open':
    case 'quit-flush-open':
      return phase === 'idle' && os === 'none'
    // close 链收尾：本链在途；或 session-end 级联已合入 'tearing-down'（幂等落定，不回退相位）
    case 'close-flush-settle':
    case 'close-flush-cancel':
      return phase === 'close-flush' || phase === 'tearing-down'
    // 汇入：唯一置位点 = before-quit 拦下 close 链在途的退出请求。OS 停机面已置时该分支
    // 不可达（级联直通在先）——「先置停机面则 quit 直通」是这里的硬不变量
    case 'quit-defer':
      return phase === 'close-flush' && os === 'none'
    // quit 链取消：只可能在本链在途时（取消 = 应用原样保留）
    case 'quit-flush-cancel':
      return phase === 'quit-flush'
    // 不可回头点：任何相位任何停机面都可置位（quit 链确认全过 / session-end 级联直通）
    case 'tear-down':
      return true
    // 收口放行：只在不可回头点之后（T 恒先于 V；调用方随即 app.quit）
    case 'quit-release':
      return phase === 'tearing-down'
    // 停机在途：任何相位任何停机面都可置位（重复 session-end 幂等）
    case 'os-shutdown-begin':
      return true
    // 复位：真退出链已接管（tearing-down/releasing）时观察窗首行即让位，本事件不可达
    case 'os-shutdown-recover':
      return phase === 'idle' || phase === 'close-flush' || phase === 'quit-flush'
  }
}

/**
 * 唯一转移点——合法性判定（表正本在模块级 isLegalExitTransition）与相位/停机面变更
 * 同处一函数；非法即 error 留痕并拒绝（状态不变，不静默放行）。
 */
function transition(ev: ExitEvent): void {
  const from = exitChainSnapshot()
  if (!isLegalExitTransition(ev, from.phase, from.osShutdown)) {
    log.error('desktop', `退出编排非法转移已拒绝：${ev} @ phase=${from.phase} os=${from.osShutdown}（状态不变）`)
    return
  }
  switch (ev) {
    case 'close-flush-open':
      exitChain.phase = 'close-flush'
      break
    case 'close-flush-settle':
      // 合入形态（级联已置 T）不回退相位——T 不可回退；余者回 idle
      if (exitChain.phase === 'close-flush') exitChain.phase = 'idle'
      break
    case 'close-flush-cancel':
      if (exitChain.phase === 'close-flush') exitChain.phase = 'idle'
      exitChain.deferredQuit = false // 取消关窗 = 待汇入的退出请求一并作废
      break
    case 'quit-defer':
      exitChain.deferredQuit = true
      break
    case 'quit-flush-open':
      exitChain.phase = 'quit-flush'
      break
    case 'quit-flush-cancel':
      exitChain.phase = 'idle'
      break
    case 'tear-down':
      exitChain.phase = 'tearing-down'
      break
    case 'quit-release':
      exitChain.phase = 'releasing'
      break
    case 'os-shutdown-begin':
      exitChain.osShutdown = 'ending'
      break
    case 'os-shutdown-recover':
      exitChain.osShutdown = 'none'
      break
  }
}

/** 相位/停机面读数快照（观测面；生产决策走下方派生读数） */
export function exitChainSnapshot(): ExitChainSnapshot {
  return { phase: exitChain.phase, osShutdown: exitChain.osShutdown, deferredQuit: exitChain.deferredQuit }
}

/** 待汇入退出请求的读并复位（唯一消费点 = close 链收尾）——正交数据不入转移表
 *  （非相位/停机面载荷，同 server-manager 的 attempts 口径：跨相位存续的独立数据，
 *  写入点唯一 = transition('quit-defer')）。 */
function takeDeferredQuitRequest(): boolean {
  const pending = exitChain.deferredQuit
  exitChain.deferredQuit = false
  return pending
}

/** 原 sessionEnding：OS 收尾（关机/注销）在途——close 直关放行 / 确认框跳过 / 观察窗复位面 */
function isOsShutdownPending(): boolean {
  return exitChain.osShutdown === 'ending'
}

/** 原 appTearingDown：真退出链已接管（置位后不可回退，故两相位等值于该旗真值） */
function isTearingDown(): boolean {
  return exitChain.phase === 'tearing-down' || exitChain.phase === 'releasing'
}

/** 原 closeFlushInFlight：close 链在途（合入 'tearing-down' 的形态见 ExitPhase 注——
 *  该形态下本读数不参与决策，两读点均已被直通闸拦在前面）。 */
function isCloseFlushInFlight(): boolean {
  return exitChain.phase === 'close-flush'
}

/** 原 quitFlushInFlight：quit 链占位中——开工 → 不可回头点 → 收口放行全程为真（旗不随
 *  流程收口复位）。等价性：'quit-flush' ⟺ 链内段；'tearing-down'/'releasing' 支等价于
 *  「T 已置」——其中唯一「T 置而 Q 被复位」的形态是 `beginShutdown()` 被拒的防御分支，
 *  彼处 beginShutdown 返回 false ⟺ gate.shuttingDown=true，本读数的调用点（before-quit
 *  的「只拦不动作」闸）另有 gate.shuttingDown 析取项兜底，故两形态逐位等价。 */
function isQuitChainEngaged(): boolean {
  return exitChain.phase === 'quit-flush' || isTearingDown()
}

/** 原 quitViaShutdown：收口放行（finally 的 app.quit 直通，二次 quit 不再拦） */
function isQuitReleased(): boolean {
  return exitChain.phase === 'releasing'
}

/** 关窗拦截的全局避让读数（原 `sessionEnding || appTearingDown`）。session-end（OS 关机/
 *  注销）时间窗有限，close 拦截只会白拖 OS 收尾（停机兜底由 session-end 处理器负责）；
 *  退出链（before-quit）自行先行 flush 并在收口 destroy 全窗，close 事件再拦截是重复动作。 */
function isExitPassthrough(): boolean {
  return isOsShutdownPending() || isTearingDown()
}

/** close 拦截的在途互斥读数（原 `closeFlushInFlight || quitFlushInFlight`）——任一 flush 链
 *  在途即只拦不起第二链（同窗双 executeJavaScript、极端时序双确认框）。'tearing-down' 支
 *  已由 isExitPassthrough 前置拦下（T 置位时本读数不参与决策）。 */
function isFlushChainInFlight(): boolean {
  return isCloseFlushInFlight() || exitChain.phase === 'quit-flush'
}

/** serverManager 退出探测（main.ts 建 manager 时接线
 *  isProcessExiting）——自愈等待/收口窗口内用户真退出则放弃恢复。 */
export function isAppTearingDown(): boolean {
  return isTearingDown()
}
/** session-end 观察窗自愈——win 上 OS 关机/注销被取消（其他应用
 *  拒绝关机、用户反悔等）时进程存活但 sessionEnding 永真 + server 已 shutdown：close
 *  拦截从此直关放行（渲染层 flush 链失效，编辑增量丢失面）、API 全断且无重启链路。
 *  session-end 置旗后起观察窗，定时器居然触发 = OS 收尾没带走进程 → 复位
 *  sessionEnding + 经 manager 钉住原端口拉回 server（渲染层 origin 不动，无缝续用）。
 *  真关机路径进程活不到窗口到点（Windows 会话收尾宽限秒级），unref 不拖收尾；
 *  时长可经 CLW_SESSION_END_RECOVERY_MS 注入（回归测试快进用）。 */
const SESSION_END_RECOVERY_MS = Number(process.env['CLW_SESSION_END_RECOVERY_MS']) || 5_000
/** session-end flush 的短预算——关机/注销窗口有限，预算只兜
 *  渲染层挂起（executeJavaScript 永不 resolve），刻意小于 server shutdown 3.5s 总超时，
 *  到点即放弃不拖 OS 收尾。可经 CLW_SESSION_END_FLUSH_BUDGET_MS 注入（回归测试快进用）。 */
const SESSION_END_FLUSH_BUDGET_MS = Number(process.env['CLW_SESSION_END_FLUSH_BUDGET_MS']) || 2_000

// ── 渲染层兜底 flush ──

/** close/quit 拦截里渲染层 flush 的总预算——本机服务下保存链毫秒级，预算只兜
 *  渲染层挂起/死循环（executeJavaScript 永不 resolve）不拖死关窗与退出。 */
const CLOSE_FLUSH_BUDGET_MS = 4_000

/** 关窗/退出前渲染层兜底 flush——主进程拦下 close/quit 后经 executeJavaScript 调渲染层
 *  window.__clwFlushBeforeClose（Book 页注册，页面未进卸载、异步保存链全通）。
 *  不走 beforeunload 同步 XHR：Chromium ≥M80 在页面卸载路径整体禁同步 XHR，实测零字节到达。
 *  同一表达式内先行冲刷全局偏好（window.__clwFlushPrefs，App.vue 注册，任何窗口可用）——
 *  prefs store 的 500ms 防抖窗内最后改动随关窗落盘；预冲刷失败吞掉不阻断 doc flush 与关窗。
 *  保持单次 executeJavaScript：execJs 调用次数与返回形状不变（main.test 断言锚定）。
 *  返回 null＝钩子不在或渲染层不可达（非编辑页无 dirty 状态，无兜底可做）。 */
async function flushRendererBeforeClose(
  target: BrowserWindow,
): Promise<{ conflict: string[]; failed: string[] } | null> {
  if (target.isDestroyed()) return null
  try {
    const r = (await target.webContents.executeJavaScript(
      '(async () => { try { await (typeof window.__clwFlushPrefs === "function" ? window.__clwFlushPrefs() : null) } catch {} return typeof window.__clwFlushBeforeClose === "function" ? window.__clwFlushBeforeClose() : Promise.resolve(null) })()',
    )) as unknown
    if (r && typeof r === 'object') {
      const pick = (v: unknown): string[] =>
        Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
      return {
        conflict: pick((r as { conflict?: unknown }).conflict),
        failed: pick((r as { failed?: unknown }).failed),
      }
    }
    return null
  } catch {
    return null
  }
}

/** close/quit/session-end 三链共用的「渲染层 flush + 预算」竞速单源——超时以哨兵分流
 *  （与 probeDirReachable 的 PROBE_TIMEOUT 同款），并以 FLUSH_BUDGET_TIMEOUT 哨兵回填结果，
 *  供调用方与 null（无钩子）分流、同权放行；race 落定即 clearTimeout（计时器卫生收编于此，
 *  竞速体走 raceWithTimeout 单源）。
 *  flushRendererBeforeClose 自吞异常不 reject，catch 仅可能收到哨兵（非哨兵照抛，防御性）。 */
const FLUSH_BUDGET_TIMEOUT = Symbol('flush-budget-timeout')
async function flushRendererWithBudget(
  target: BrowserWindow,
  budgetMs: number,
): Promise<{ conflict: string[]; failed: string[] } | null | typeof FLUSH_BUDGET_TIMEOUT> {
  return raceWithTimeout(flushRendererBeforeClose(target), budgetMs, FLUSH_BUDGET_TIMEOUT)
}

/** 冲突未决的原生确认——Electron 不渲染浏览器 Leave-site
 *  确认框，渲染层 preventDefault 是无反馈死关窗；冲突项又无法代存（autosave/flush
 *  均跳过 conflict 项）。返回 true＝放弃未保存的本地修改继续关/退。 */
function confirmDiscardConflicts(parent: BrowserWindow, count: number): boolean {
  return (
    dialog.showMessageBoxSync(parent, {
      type: 'warning',
      title: 'CLWriting',
      message: `有 ${count} 个文档存在未解决的保存冲突，未保存的本地修改将丢失。`,
      detail: '冲突需要在应用内选择「重载」或「覆盖」后才能自动保存。',
      buttons: ['放弃修改并继续', '取消'],
      defaultId: 1,
      cancelId: 1,
    }) === 0
  )
}

/** 保存失败的原生确认——flush 钩子返回的
 *  failed（保存失败的 docId 列表，产出面 web-next stores/doc.ts flushBeforeClose）
 *  与 conflict 同属「flush 未落净」：本链路无法代存，零消费＝编辑增量静默丢失
 * （违背「编辑永不静默丢失」红线）。与 confirmDiscardConflicts 同款交互（type 用
 *  error 区分失败/冲突语义），返回 true＝放弃失败的修改继续关/退；取消后作者可
 *  重试保存或排查本地服务状态。 */
function confirmDiscardFailed(parent: BrowserWindow, count: number): boolean {
  return (
    dialog.showMessageBoxSync(parent, {
      type: 'error',
      title: 'CLWriting',
      message: `有 ${count} 个文档保存失败，这些文档里最近的修改尚未落盘。`,
      detail: '可先取消，回到应用内重试保存或检查本地服务状态后再关闭；若继续，这些修改将被丢弃。',
      buttons: ['放弃修改并继续', '取消'],
      defaultId: 1,
      cancelId: 1,
    }) === 0
  )
}

/**
 * close/quit 两链的 flush→确认→取消复位流程双写单源。
 * 流程（两链原序逐位保留）：
 *   flushRendererWithBudget（预算竞速）→ 超时 warn / 无钩子 info 留痕（文案各链注入）
 *   → skipConfirms 停机复查留痕（仅 close 链传）→ conflict 原生确认 → failed 留痕 +
 *   原生确认 → 取消即 onCancel（复位各自在途旗/丢弃切库意图/回写回滚基线——复位时机
 *   原样）并返回 'cancel'。
 * 返回 'proceed' = 确认全过（或无可确认），调用方接各自收尾（close 链 destroy 单窗、
 * quit 链 appTearingDown + 全窗 destroy）。
 */
interface FlushConfirmOpts {
  budgetMs: number
  /** 超时态 warn 文案（两链措辞各一，逐字保留） */
  timeoutLog: string
  /** 无钩子/渲染层不可达态 info 文案（两链措辞各一，逐字保留） */
  idleLog: string
  /** failed 留痕前缀（「关窗兜底」/「退出前」——原文案逐字拆分点） */
  failedPrefix: string
  /** flush 落定后补停机复查——仅 close 链传入（isExitPassthrough（原
   *  sessionEnding/appTearingDown）在途时跳过确认框：停机窗口内无人可答），quit 链无此项。
   *  Thunk 形态：竞窗语义是「flush 落定后」再读相位/停机面（close 先到 → flush 在途 →
   *  session-end 后置也命中），调用时快照布尔会漏掉后置置位——评估点固定在 flush 落定后
   *  （flushRendererWithBudget await 之后的唯一读取点）。 */
  skipConfirms?: () => boolean
  /** 确认被取消：复位旗/丢弃切库意图（各链差异点）。
   *  可为 async——quit 链的取消要回写 workdir.json 回滚基线，回写等待已异步化
   *  （跨进程锁异步孪生），调用点 await 后本函数才返回 'cancel'：取消链的收口顺序
   *  与同步形态一致，仅把「回写未落定即返回」的窗口关掉（调用方随后 return，
   *  不会再等待回写）。close 链取消仍是纯同步置旗，await 一个 void 等价。 */
  onCancel: () => void | Promise<void>
}
async function runFlushConfirm(win: BrowserWindow, opts: FlushConfirmOpts): Promise<'proceed' | 'cancel'> {
  // 超时态 warn、无钩子态 info——保存链慢盘/server 退避窗下超时窗内的最后键入静默丢失
  // 且零诊断线索；哨兵归一化回 null 后进下游，conflict/failed 守卫沿用 null 假值语义。
  const raced = await flushRendererWithBudget(win, opts.budgetMs)
  const res = raced === FLUSH_BUDGET_TIMEOUT ? null : raced
  if (raced === FLUSH_BUDGET_TIMEOUT) {
    log.warn('desktop', opts.timeoutLog)
  } else if (raced === null) {
    log.info('desktop', opts.idleLog)
  }
  // thunk 在此评估（flush 落定后，不是链首快照）——链首快照会漏掉 flush 在途期后置的置旗
  const skipConfirms = opts.skipConfirms?.() === true
  if (skipConfirms && res && (res.conflict.length > 0 || res.failed.length > 0)) {
    // 命中即 warn 留痕未落净清单（停机窗口内无人可答，只留痕不弹窗）后直落收口 destroy。
    log.warn(
      'desktop',
      `关窗兜底 flush 落定但${isOsShutdownPending() ? 'OS 停机' : '应用退出收尾'}已在途，跳过冲突/失败确认直接关窗（停机窗口内无人可答）：冲突 ${res.conflict.length} 个、保存失败 ${res.failed.length} 个`,
    )
  }
  if (res && res.conflict.length > 0 && !win.isDestroyed() && !skipConfirms) {
    // 冲突未决的本地修改无法代存，原生确认给作者最后一念
    if (!confirmDiscardConflicts(win, res.conflict.length)) {
      await opts.onCancel()
      return 'cancel'
    }
  }
  if (res && res.failed.length > 0 && !win.isDestroyed() && !skipConfirms) {
    // 保存失败（failed = 保存失败的 docId 列表）与冲突同属「flush 未落净」——本链路无法
    // 代存，零消费＝编辑增量静默丢失。先留痕失败清单（只是文档 id，供诊断），再弹原生确认。
    log.error(
      'desktop',
      `${opts.failedPrefix} flush 有 ${res.failed.length} 个文档保存失败（${res.failed.join(', ')}），需作者确认是否放弃未落盘修改`,
    )
    if (!confirmDiscardFailed(win, res.failed.length)) {
      await opts.onCancel()
      return 'cancel'
    }
  }
  return 'proceed'
}

// ── 依赖注入面（main.ts 装配时传入——显式参数，对齐纯函数抽离纪律）──

/** lifecycle 所需的最小 server 管理面（ReturnType 推断，避免放大 server-manager 导出面）。 */
type ServerManagerLike = ReturnType<typeof import('./server-manager.js').createStudioServerManager>

interface MainWindowLifecycleDeps {
  serverManager: ServerManagerLike
  /** session-end 观察窗自愈的「有服务可拉回」判据——bootstrap 本轮是否 fork
   *  了 studio server（dev HMR 态只复位旗、不拉服务，API 由独立 dev:api 进程供给） */
  isServerStarted: () => boolean
}

/** before-quit 链所需的停机门最小面（bootstrap-runner 结构子集）。 */
interface ShutdownGateLike {
  beginShutdown(): boolean
  readonly shuttingDown: boolean
}

/** 主窗生命周期监听装配（挂载顺序 = 链路顺序）：
 * close 拦截链 → session-end 链 → focus 关书库窗 → closed 退出链 → 全屏反向同步。
 */
export function attachMainWindowLifecycle(win: BrowserWindow, deps: MainWindowLifecycleDeps): void {
  const { serverManager } = deps
  // 关窗兜底——首轮 close 先 preventDefault，经渲染层钩子异步 flush（页面未死，异步保存链
  // 全通）落定/短超时后 destroy 真正关窗（destroy 不再触发 beforeunload，链路单次不循环）。
  // 退出链（before-quit）已先行 flush 并在收口 destroy 全窗，session-end 时间窗有限，两者都直接放行。
  // 两链互斥与 quit 汇入收编退出编排状态机（相位/停机面读数 + transition；复位随链路收尾
  // 统一，destroy 后 close 不再触发故复位无副作用），见本文件顶部状态机段。
  win.on('close', (e) => {
    saveWinState()
    // OS 收尾（session-end）/退出收尾（appTearingDown，退出链自行 flush+destroy 全窗）期直关
    // 放行——时间窗有限，不在窗口里白等渲染层 flush（session-end 链自身已尽力 flush）
    if (isExitPassthrough()) return
    // close/quit 任一 flush 链在途——只拦不再起第二链（同窗双 executeJavaScript、极端时序
    // 双确认框），在途链自会收口（close 链 destroy 收尾 / quit 链统一 destroy 全窗）；
    // 拦下而非放行，防在途 flush 写到一半窗口被原生 close 走 beforeunload 关死（保存链半途丢失）。
    if (isFlushChainInFlight()) {
      e.preventDefault()
      return
    }
    e.preventDefault()
    transition('close-flush-open')
    void (async () => {
      const target = wins.mainWindow
      if (!target || target.isDestroyed()) {
        // 退化形态（窗口先于本链销毁）也收在途相位，防卡死后续 quit 汇入
        transition('close-flush-settle')
        return
      }
      const outcome = await runFlushConfirm(target, {
        budgetMs: CLOSE_FLUSH_BUDGET_MS,
        // 超时态 warn（文案逐字保留，用户可见）
        timeoutLog: `关窗兜底 flush 超时（≥${CLOSE_FLUSH_BUDGET_MS}ms）未落定即关窗——超时窗内未保存的键入可能丢失`,
        idleLog: '关窗兜底 flush 无钩子/渲染层不可达（非编辑页常态），直接关窗',
        failedPrefix: '关窗兜底',
        // flush 落定后补停机复查（session-end/before-quit 在途不弹确认）
        // thunk：相位/停机面在 flush 在途期后置也命中（评估点在 runFlushConfirm 内 flush 落定后）
        skipConfirms: () => isExitPassthrough(),
        // 作者放弃关窗 → 待汇入的退出请求一并作废（与 quit 链自身 cancel
        // 「取消即中止退出、应用原样保留」语义一致）
        onCancel: () => transition('close-flush-cancel'),
      })
      if (outcome === 'cancel') return
      try {
        if (!target.isDestroyed()) target.destroy()
      } catch (err) {
        // 收尾期 destroy 可抛（平台/生命周期边角）：吞掉防 async 链成未处理拒绝，
        // 窗口交由 Electron 退出流程兜底收口
        log.error('desktop', '关窗兜底 flush 后 destroy 异常（交退出流程兜底）', err)
      }
      // 收尾相位在链路尾（destroy 后 close 不再触发，复位无副作用）；
      // close flush 在途时到达的退出请求由此统一汇入 app.quit——多窗态下
      // window-all-closed 不触发，只能这里补发；单窗态与 window-all-closed 双发
      // 在 before-quit 幂等收敛（quit 链占位/停机门）。
      transition('close-flush-settle')
      if (takeDeferredQuitRequest()) app.quit()
    })()
  })
  // win 会话收尾兜底——OS 关机/重启/注销对主窗发 session-end（不可阻止，时间窗有限）：
  // 不接管则整条优雅停机链被跳过、utility child 随进程硬死（在途 session/end 落库全失，
  // 靠 10min 孤儿会话宽限兜底）。尽力下发停机指令（shutdown 内部有 3.5s 总超时，不会拖住 OS 收尾）。
  win.on('session-end', () => {
    // OS 关机/注销窗口有限——置停机面让上方 close 拦截放行直关，不在有限窗口里白等渲染层
    // flush（本条链路的停机兜底以 server 停机指令为准）
    transition('os-shutdown-begin')
    // RC（顺序不变量，勿改）：**先落 flush 再下发停机指令**——与 quit 链
    // 「先存后停服」同一条不变量（test/desktop/main-close-flush.test.ts 的 before-quit
    // 用例已有顺序锚）。为什么必须这个序：渲染层 flush 要走 executeJavaScript 往返 →
    // 前端钩子 → fetch PUT，而 shutdownStudio 逐书 abort 后立即 server.close（不再
    // accept 新连接）——并行下发时迟到的 PUT 连连接都进不来，自动保存节拍内（默认 30s）
    // 的最后键入静默丢失（「编辑永不静默丢失」红线）。
    // 等待仍有界：flush 预算 2s + shutdown 3.5s 总超时 ≈ 5.5s，仍在观察窗（5s 到点→
    // restartPinned 有界等待 5s）覆盖内；且渲染层已销毁/钩子缺失时 flush 立即返回，
    // 延迟近零——不是无条件 sleep。
    // conflict 项本就无法代存、failed 停机窗口内无人在场可答，两者只留痕不弹窗
    //（原生确认框会反把进程钉死在收尾期）。
    void (async () => {
      try {
        const target = wins.mainWindow
        if (!target || target.isDestroyed()) return
        // race 收敛 flushRendererWithBudget 单源（超时哨兵/落定清理随函数收编）；
        // 未落定（无钩子/超时）恒 info，尽力而为不拖停机。
        const res = await flushRendererWithBudget(target, SESSION_END_FLUSH_BUDGET_MS)
        if (res === null || res === FLUSH_BUDGET_TIMEOUT) {
          log.info('desktop', 'session-end 渲染层 flush 未落定（钩子缺失/超时，尽力而为不拖停机）')
          return
        }
        if (res.conflict.length > 0 || res.failed.length > 0) {
          log.error(
            'desktop',
            `session-end 渲染层 flush 落定但未落净：冲突 ${res.conflict.length} 个、保存失败 ${res.failed.length} 个（停机窗口内无人可确认，仅留痕）`,
          )
          return
        }
        log.info('desktop', 'session-end 渲染层 flush 落净')
      } finally {
        // 停机指令恒下发（顺序不变量的一部分）：走 finally 而非 IIFE 尾部——「窗口已先销毁」
        // 等早退分支也必须把停机指令送到 child，child 自己收尾在途 session/end 落库。
        await serverManager.shutdown().catch((err) => log.error('desktop', 'session-end 停机失败（OS 即将收尾）', err))
      }
    })()
    // 停机前补存窗口状态——OS 关机/注销走 session-end，主窗 close 事件不保证收到（不存则
    // 窗口位置/尺寸丢失，下次开窗回默认位）。存状态是一次内存读 + 原子写，毫秒级不挤占停机
    // 窗口；saveWinState 内部已吞错，外层 try/catch 双保险（收尾期 Electron getter 可抛），
    // 失败不阻断停机。
    try {
      saveWinState()
    } catch {
      /* 存状态失败不阻断停机（窗口状态非关键数据，宁可丢状态也要下发停机指令） */
    }
    // 顺序不变量（close/quit/session-end 三链同序）：窗口状态落盘（同步，本行之前）→
    // 渲染层 flush 落定/到点 → 下发停机（停机指令在上方 IIFE 的 finally）。
    // 观察窗（语义见常量声明处注释）——OS 真收尾时进程活不到到点
    //（timer 无从触发）；到点仍存活即关机被取消/被拒，复位停机面并拉回 server。
    // 重复 session-end 重臂不叠窗；unref 不拖真收尾。
    if (exitChain.osRecoveryTimer) clearTimeout(exitChain.osRecoveryTimer)
    const recoveryTimer = setTimeout(() => {
      exitChain.osRecoveryTimer = null
      if (isTearingDown()) return // 真退出链已接管（closed → app.quit → before-quit）
      transition('os-shutdown-recover')
      log.info('desktop', 'session-end 观察窗到点进程仍存活——判定 OS 关机未收尾（被取消/被拒），复位 close 直关旗')
      if (!deps.isServerStarted()) return // dev HMR 态无 server（API 由独立 dev:api 进程供给）
      if (!wins.mainWindow || wins.mainWindow.isDestroyed()) return // 窗已不在：退出链接管，不白 fork
      void serverManager.restartPinned().then((recoveredPort) => {
        if (recoveredPort === null) {
          log.error('desktop', 'session-end 自愈：studio server 恢复失败（编辑仍在渲染层，API 不可用——建议重启应用）')
        }
      })
    }, SESSION_END_RECOVERY_MS)
    recoveryTimer.unref()
    exitChain.osRecoveryTimer = recoveryTimer
  })
  // 书库管理窗口「用完即走」：主窗口获焦 = 用户已切回，关闭书库窗口释放资源
  // （与书架窗口 desktop:open-book 主动 close 行为对齐）
  win.on('focus', () => {
    if (wins.libraryWindow && !wins.libraryWindow.isDestroyed()) {
      wins.libraryWindow.close()
    }
  })
  win.on('closed', () => {
    // 异常隔离——本监听承载退出链（app.quit），不得被任何前置 closed 监听
    // 抛错短路；此处自身异常也只留痕（交 uncaughtException 兜底），不静默取消退出。
    guardClosedCleanup('主窗口退出链', () => {
      // 只认当前主窗的关闭——重跑 bootstrap 前回收的陈窗已被摘除 wins 引用
      // （见 windows.ts reclaimStaleMainWindow），其关闭不得当成本轮主窗关闭而退出应用
      if (wins.mainWindow === win) {
        wins.mainWindow = null
        // 主窗口是应用核心：关闭即退出（连带销毁书架/书库子窗口，杜绝孤儿窗口 / 僵尸进程）
        app.quit()
      }
    })
  })
  // 专注模式全屏反向同步：作者经系统手势（⌘⌃F/绿按钮）退出全屏时通知渲染层
  //（渲染层据此连带退出专注模式）。只回发事实，不在主进程持有专注语义。
  // 与 render-process-gone 同款：捕获局部 win，闭包不追迟来的 mainWindow 置空。
  const fsWin = win
  win.on('enter-full-screen', () => {
    if (!fsWin.isDestroyed()) fsWin.webContents.send('desktop:fullscreen-change', true)
  })
  win.on('leave-full-screen', () => {
    if (!fsWin.isDestroyed()) fsWin.webContents.send('desktop:fullscreen-change', false)
  })
}

/**
 * before-quit 优雅退出链装配。beginShutdown 幂等（二次 quit 直通，shutdownStarted 归
 * runner 自持）；before-quit 走 shutdown 指令——child 内 shutdownStudio（在途编排
 * abort/session/end 落库）落定后 shutdown-done 回执退出；3.5s 总超时（见 server-manager
 * SHUTDOWN_TOTAL_TIMEOUT_MS）强杀兜底在 manager 内。
 */
export function registerQuitChain(gate: ShutdownGateLike, serverManager: ServerManagerLike): void {
  // 优雅停机在途期间的再次 quit 请求一律 preventDefault——放行直通会在 3.5s 优雅窗口内
  // 强杀 child（在途 chat/self-heal 的 session/end 落库被打断）；首次流程的 finally 会统一
  // app.quit 收口。beginShutdown 不复位（runner 生命周期语义），为防拦掉自己的 quit 成
  // 死循环，用状态机相位 'releasing'（原本地 quitViaShutdown 旗）区分「finally 里我们
  // 自己发起的 quit」放行直通。
  // 顺序不变量：退出链先行渲染层 flush，再 shutdown 杀 server——反序则渲染层任何保存
  //（含 close 拦截兜底）都打向已死端口必失败，最后一个 autosave 间隔内的键入随退出静默
  // 丢失。流程：flush（≤CLOSE_FLUSH_BUDGET_MS）→ 冲突未决可原生确认取消退出（不
  // beginShutdown，窗口/server 原样保留）→ beginShutdown → shutdown → 收口 destroy 全窗
  //（app.quit 的隐式关窗会走渲染层 beforeunload，preventDefault 类守卫在无监听方时拦死
  // 退出链）→ quit-release 放行 quit。
  // 相位/停机面的全部变更经 transition（唯一转移点）；本链与 close 链共享同一状态源。
  app.on('before-quit', (e) => {
    if (isQuitReleased()) {
      // 收口放行前兑现迟到的切库意图（意图在不可回头点之后才置位的边角——
      // 停机在途窗口内的 switch-library → relaunch → 二次 quit 被拦只记旗），
      // 正常退出（无意图）零副作用
      armPendingRelaunchIfAny()
      return // 收口 quit 放行直通
    }
    // session-end 在途的级联 quit 直通——OS 关机/注销收尾期
    //（停机面已置、server 已下发停机、渲染层将死）主窗 closed →
    // app.quit 会二次进本链：flush 打向已死 server 必落空，conflict/failed 的
    // 原生同步确认无人可答（把进程钉死在 OS 收尾窗口内）。session-end 链已完成
    // 尽力而为三件（flush / 存窗口状态 / 停机指令），此处不再起交互链、不
    // preventDefault，放行原生退出（close 拦截已按停机面直关放行）。
    if (isOsShutdownPending()) {
      // 直通分支补置不可回头点——本分支不 preventDefault、随后进程退出，不置时
      // 5s 观察窗（见 SESSION_END_RECOVERY_MS 声明处）在其到点前若仍触发，会把停机面
      // 复位并拉回 server（重启 child）造孤儿。置位后观察窗首行即让位；同时给退出期的
      // serverManager 探测与 close 拦截统一「真退出」口径（此前只靠「主窗已空」兜底）。
      transition('tear-down')
      log.info('desktop', 'session-end 在途的级联 quit：放行直通（不再起交互链）')
      return
    }
    e.preventDefault()
    // close 链 flush 在途——只拦不另起第二链（同窗双
    // executeJavaScript、极端时序双确认框），置位待汇入（原 quitDuringCloseFlush）
    // 由 close 链收尾统一汇入 app.quit（close 链 destroy 后补发；单窗态
    // window-all-closed 同样触发，幂等收敛）。
    // 不直接放行 quit：在途 flush 会被退出连带打断（保存写一半），丢 flush。
    if (isCloseFlushInFlight()) {
      transition('quit-defer')
      return
    }
    // flush 在途（本轮已拦）或停机在途（等 finally 统一收口）都只拦不动作
    if (isQuitChainEngaged() || gate.shuttingDown) return
    transition('quit-flush-open')
    void (async () => {
      // quit 链补存窗口状态——根因：本链收口 destroy 全窗（下方 finally）不触发
      // 'close' 事件（Electron 语义），close 拦截首行的 saveWinState 在本链不达；
      // 而 Cmd+Q / win 菜单退出 / 崩溃风暴对话框退出 / 切库 relaunch（relaunch →
      // app.quit）全汇入本链——退出前的窗口几何变更会静默丢失（session-end 链同款补存）。
      // 补点在链首：窗口仍存活、任何 flush/确认/destroy 之前；saveWinState 内部已吞错、
      // 幂等（close/session-end 链已存时重写同值），冲突/失败确认取消退出路径多存一次
      // 当前几何亦无副作用。收口放行（相位 'releasing'）的早退分支不另补——该相位只在
      // 下方 IIFE 内落位（补点之后），二次进 quit 链时状态已存过、窗口已销毁。
      saveWinState()
      try {
        const win = wins.mainWindow
        if (win && !win.isDestroyed()) {
          const outcome = await runFlushConfirm(win, {
            budgetMs: CLOSE_FLUSH_BUDGET_MS,
            // 与 close 链同款留痕（超时态 warn/无钩子态 info，「退出前」措辞逐字保留）
            timeoutLog: `退出前 flush 超时（≥${CLOSE_FLUSH_BUDGET_MS}ms）未落定即退出——超时窗内未保存的键入可能丢失`,
            idleLog: '退出前 flush 无钩子/渲染层不可达（非编辑页常态），继续退出',
            failedPrefix: '退出前',
            // 取消 = 丢弃切库意图（退出语义不被劫持成重启）
            // 取消 = 回写旧库（跨会话不残留被取消的新库）
            // 回写等待已异步化（writeStore 的跨进程锁走异步孪生），本回调 await 完
            // 才让 runFlushConfirm 返回 'cancel'——退出取消路径的盘面落定不再靠
            // fire-and-forget（否则取消后立即再退一次会与在途回写交错）
            onCancel: async () => {
              transition('quit-flush-cancel')
              discardPendingRelaunch()
              await rollbackCancelledSwitch()
            },
          })
          if (outcome === 'cancel') return
        }
      } catch (err) {
        log.error('desktop', '退出前渲染层 flush 异常（继续退出）', err)
      }
      transition('tear-down')
      // 不可回头点——flush 冲突/失败确认全过、停机将启，此刻兑现切库意图
      //（武装重启 + 交接释放锁）；取消路径到不了这里，意图已在上方丢弃
      armPendingRelaunchIfAny()
      if (!gate.beginShutdown()) {
        // 已在优雅停机在途：本 async 流退出，等在途流程的 finally 统一收口。相位不回落
        // ——不可回头点已置（原 appTearingDown 置位点在本判断之前，且该旗不随本分支复位），
        // 「quit 链让位」的读数（isQuitChainEngaged 的 tearing-down 支 + gate.shuttingDown）
        // 与原 `quitFlushInFlight = false` 形态逐位等价：beginShutdown 返回 false ⟺
        // gate.shuttingDown=true，而该旗的唯一读点（上方 before-quit 的只拦不动作闸）
        // 另有 gate.shuttingDown 析取项兜底。
        return
      }
      // shutdown 可能 reject（child 已死时 postMessage/kill 抛错等）：不 catch 则
      // rejection 成 unhandledRejection（丢现场）、quit 收口悬空。包 try/catch + .catch
      // 记日志，finally 仍 quit——退出收口不因停机失败而挂死。
      try {
        void serverManager
          .shutdown()
          .catch((err) => log.error('desktop', '优雅停机 shutdown 失败（继续退出）', err))
          .finally(() => {
            // destroy 直关全部窗口——绕过渲染层 beforeunload（防守卫类
            // preventDefault 拦死隐式关窗）；收尾期 destroy 可抛，逐窗隔离不阻断退出
            for (const w of [wins.mainWindow, wins.shelfWindow, wins.libraryWindow]) {
              try {
                if (w && !w.isDestroyed()) w.destroy()
              } catch {
                /* 单窗销毁失败不阻断其余窗口与退出收口 */
              }
            }
            // 收口放行（原 quitViaShutdown 置位）→ 自己的 quit 再进 before-quit 时直通
            transition('quit-release')
            app.quit()
          })
      } catch (err) {
        // 防御：shutdown 同步抛（当前为 async fn 不可达，防将来重构回归同型挂死）
        log.error('desktop', '优雅停机 shutdown 同步抛错（继续退出）', err)
        armPendingRelaunchIfAny() // 兜底收口同样过不可回头点，切库意图不失
        for (const w of [wins.mainWindow, wins.shelfWindow, wins.libraryWindow]) {
          try {
            if (w && !w.isDestroyed()) w.destroy()
          } catch {
            /* 同上：单窗销毁失败不阻断退出收口 */
          }
        }
        transition('quit-release')
        app.quit()
      }
    })()
  })
}
