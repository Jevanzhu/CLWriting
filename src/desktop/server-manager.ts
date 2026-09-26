/**
 * main 侧 studio server 子进程管理器（阶段 22 批次 K）。
 *
 * 批：fork server-utility 入口 + parentPort 握手（ready 端口回传 / boot-error
 * 信封）+ studioToken 首启生成/原子持久化（A）/启动读入内存一次、fork 一律复用
 * 内存值+ stopChild（kill + 等退出）。
 * 批：shutdown 指令下发 + shutdown-done 回执/3.5s 总超时强杀（覆盖 child 最坏预算）+ shutdownStarted
 * 状态门+ stdio:pipe 日志单写者转发（§3.5：CLW_LOG_STDOUT=1 注入 + JSON 行
 * 解析按 level/tag/err 重发，err 透传，坏行原文兜底）。
 * 批（本文件当前态）：崩溃退避自动重启——exit 非主动停机即排程重启（立即/5s/15s
 * 三档，3 次自动重启后再崩走 onRestartExhausted 封顶回调（main 接原生对话框）；
 * ready 后稳定 stabilityResetMs 计数清零（/——偶发单次崩溃不累计到 3 误弹）；
 * 重启钉住最近一次成功端口 + 同一内存 token（前端恢复链只认一次 boot 的同源
 * 端口，token 换代即永久 403）；重启期 EADDRINUSE 等握手失败按退避继续（§3.4 时序
 * 3）；重启全程占 starting 通道（握手在途窗口内并发 start 复用在途轮不双
 * fork）；shutdown/stopChild/start 三面取消挂起重启（退出途中 fork 新 child 成孤儿
 * 直接打挂验收门 4）。
 *
 * fork 以依赖注入暴露（测试换假件，不 mock electron 整模块）；入口路径按本模块
 * 产物位置派生（dist/desktop/server-utility.js，asar 内等价—— 同 server-main
 * dirname 派生先例）。env 显式展开 process.env + CLW_LOG_STDOUT=1（不污染 main 自身
 * process.env）。
 *
 * （全项目源码质量与优雅度评审）：启动/重启/退避/停止
 * 原由 12 个闭包变量的布尔旗与计数器组合隐式表示（合法组合只写在注释的正确性证明里），
 * 现收敛为显式状态机——一个 state 容器（相位载荷 + 停机面三值 + 计数 + 最近成功面 +
 * 正交数据）+ 派生读数（phaseOf/killMarked/isShutting）+ 单一转移点 transition
 * （合法性表 isLegalTransition，非法转移记 error 并拒绝，不静默放行）。行为逐位不变。
 */
import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { utilityProcess } from 'electron'
import { atomicWriteFile } from '../fs/atomic.js'
import { log } from '../log/index.js'
import {
  ServerBootError,
  KILL_WAIT_TIMEOUT_MS,
  delay,
  handshake,
  killProcAwaitEscalating,
  type LogLike,
  type UtilityProcessLike,
} from './server-proc.js'
import { forwardChildStdio } from './server-log.js'
// 0918三拍板批（KEK v2）：OS 凭据通道 IKM 装置（主进程 safeStorage；deps 可注入测试假件）
import { loadOrGenerateOsKek } from './os-kek.js'

// 拆分桥接：迁出公开导出逐名 re-export，全库 import 面零改动。
// 缝 1（desktop/server-proc.ts，进程管理族）：启动失败错误类 + 日志通道契约。
export { ServerBootError } from './server-proc.js'
export type { LogLike } from './server-proc.js'
// 缝 2（desktop/server-log.ts，服务端日志转发族）：stdio 单写者转发族。
export { MAX_LINE_CHARS, forwardLogLine, splitLines } from './server-log.js'

/** fork options 可辨识名：getAppMetrics 单列（ProcessMetric.name），*/
export const STUDIO_SERVICE_NAME = 'studio-server'

/**
 * shutdown 总超时：不等 shutdown-done 回执的兜底（与拆分前 before-quit 2s 同量级，§3.4 时序 4）。
 * child 侧 graceful-shutdown 最坏预算 = close 1.5s + settle 1.5s 串行
 * ≈3s——原 2s 会在收尾窗口内强杀，打断 session/end 落库；提到 3.5s 覆盖 child 最坏
 * 预算（改动面最小、语义直白：main 兜底必须 ≥ child 自身兜底之和，否则兜底变打断）。
 * 测试经 shutdownTotalMs 注入缩短，不依赖本值保快。
 */
export const SHUTDOWN_TOTAL_TIMEOUT_MS = 3_500
/**
 * shutdown 等 settleStarting（在途 start/自动重启握手落定）的
 * 短预算——此前裸 await 无预算，握手挂起（child 模块加载卡死等）最坏
 * HANDSHAKE_TIMEOUT_MS(30s) + kill 升级 2s×2 才落定，用户点退出最坏 ~41s「关不掉」。
 * 预算内未收口 → 放弃等握手，对在途 fork 直接 kill 收口（握手期 server 未 ready、
 * 无在途编排可丢，硬杀无语义损失）；正常路径（握手毫秒级落定）语义不变。测试经
 * shutdownSettleBudgetMs 注入缩短，不依赖本值保快。
 */
const SHUTDOWN_SETTLE_BUDGET_MS = 2_000
/** 崩溃退避序列（第 1/2/3 次自动重启前的等待；建议立即/5s/15s） */
const RESTART_BACKOFF_MS: readonly number[] = [0, 5_000, 15_000]
/** 自动重启次数上限：第 3 次重启后的再崩溃不再自动重启，转 onRestartExhausted 决断 */
const RESTART_MAX_ATTEMPTS = 3
/** ready 后稳定窗口：child 存活过此窗口即清零重启计数（/偶发单崩不累计） */
const STABILITY_RESET_MS = 5 * 60_000
/**
 * restartPinned 在 shuttingDown 态等停机收口的上限。session-end
 * 观察窗（main 侧 SESSION_END_RECOVERY_MS，缺省 5s）与停机链最坏预算失配：
 * SHUTDOWN_SETTLE_BUDGET_MS 2s + SHUTDOWN_TOTAL_TIMEOUT_MS 3.5s + KILL_WAIT_TIMEOUT_MS
 * 2s×2 段 ≈ 慢而正常收尾 ~5.5s / child 挂死 ~9.5-11.5s（自 session-end 起算）——观察窗
 * 到点时停机常仍在途，原「立即返 null」令自愈被拒（OS 关机被取消 + child 收尾偏慢的
 * 复合场景下用户面对 API 不可用）。取独立常量 5s（与观察窗同长）：覆盖慢而正常收尾的
 * 全部残余（窗口到点后仍余 ≥0.5s）与挂死形态的大部分（合计 ~10s），超出即放弃，保
 * 「恢复失败」呈现有界、不把自愈拖成第二台常驻等待器。测试经 restartShutdownWaitMs
 * 注入缩短，不依赖本值保快。
 */
const RESTART_SHUTDOWN_WAIT_MS = 5_000

interface ForkOptionsLike {
  serviceName?: string
  stdio?: 'pipe' | 'inherit'
  env?: Record<string, string | undefined>
}

export interface ServerManagerDeps {
  /** 缺省真实 utilityProcess.fork；测试注入假件 */
  fork?: (modulePath: string, args: string[], options: ForkOptionsLike) => UtilityProcessLike
  /** 缺省 src/log；测试注入捕获件 */
  logger?: LogLike
  /** shutdown 总超时（指令下发到强杀兜底前）；测试注入缩短保快 */
  shutdownTotalMs?: number
  /** shutdown 等 settleStarting 的短预算（超时即放弃等握手、
   *  kill 在途 fork）；缺省 2s，测试注入缩短保快 */
  shutdownSettleBudgetMs?: number
  /** kill 后等退出的上限；测试注入缩短保快 */
  killWaitMs?: number
  /** 退避序列（第 1/2/3 次重启前等待）；缺省 [0, 5000, 15000]，测试注入缩短保快 */
  backoffMs?: readonly number[]
  /** ready 后稳定窗口，届时重启计数清零（/）；缺省 5 分钟 */
  stabilityResetMs?: number
  /** restartPinned 在 shuttingDown 态等停机收口的上限；
   *  缺省 RESTART_SHUTDOWN_WAIT_MS（5s），测试注入缩短保快 */
  restartShutdownWaitMs?: number
  /** 本进程退出探测（main 注入 appTearingDown 读数）——自愈
   *  等待/收口窗口内用户真退出则放弃恢复（不在退出链上 fork 新 child 成孤儿，
   *  /同向）；缺省恒 false（无接线不放弃） */
  isProcessExiting?: () => boolean
  /**
   * 3 次自动重启耗尽后的用户决断（main 接原生对话框：重启服务/退出）：
   * 'restart' = 计数清零立即人工重启；'quit' = 不再重启（main 侧自行 app.quit）。
   * 缺省 'quit'——无接线不盲启（测试/降级态安全缺省）。
   */
  /** 封顶决断回调。（-②）：允许返回 Promise——main 侧对话框改异步
   *  showMessageBox（同步版泵原生嵌套消息循环，崩溃风暴路径上冻结三窗口输入/IPC）；
   *  决断到达前不重启不退出（本侧 void 适配，exit 回调不等它）。 */
  onRestartExhausted?: () => 'restart' | 'quit' | Promise<'restart' | 'quit'>
  /** （§四.3）：自动重启（doRestart）/session-end
   *  自愈（restartPinned）钉住端口拉回成功后的广播钩子——main 接线后向存活渲染层
   *  广播 desktop:server-restarted（渲染层 sse.resync 主动重连续用同源）。
   *  缺省无操作——无接线不广播（测试/降级态安全缺省）。 */
  onRestarted?: (port: number) => void
  /** 0918三拍板批（KEK v2）：OS 凭据通道 IKM 装置——缺省真件（safeStorage +
   *  os-kek.json），测试注入假件（fixtures 无 vi.mock 纪律，同 fork 注入款）。 */
  loadOsKek?: (userDataPath: string) => Buffer | null
  /**
   * 状态机转移轨迹钩子（缺省无操作）——每次转移回调一次（含被拒的
   * 非法转移，legal=false）。转移矩阵测试经此断言转移序列与非法拒绝；生产不接线
   * （不落盘、不广播），钩子抛错被隔离，不得反噬状态机。
   */
  onTransition?: (trace: TransitionTrace) => void
}

interface StartStudioServerOptions {
  /** null = welcome 态（fork 不带 --dir） */
  workDir: string | null
  /** Electron userData 目录（child 无 app 对象，经 --user-data 下发） */
  userDataPath: string
  /** --book 下沉的书名（main 侧已 resolveInitialBook，附带） */
  book?: string | null
  /** dev 态传 true → child 附 --mirror-console（打包态 false 不传） */
  mirrorConsole?: boolean
  /** 阶段 53 ：应用版本号（main 侧 `app.getVersion`；child 无 app 对象，经 env
   *  CLW_APP_VERSION 下发）。缺省不注入——dev/测试形态 child 回落读 package.json。 */
  appVersion?: string
}

interface ActiveChild {
  proc: UtilityProcessLike
  port: number
  /** ready 后注册：exit 事件 resolve（stopChild 等退出用；重启也挂此处） */
  exited: Promise<void>
}

// ─── （全项目源码质量与优雅度评审）：显式状态机 ───
// 旧实现把「启动/重启/退避/停止」编码在 12 个闭包变量（active/starting/startingOpts/
// startingProc/shutdownStarted/shuttingDown/restartTimer/restartCount/lastOpts/
// pinnedPort/token/waiters）的布尔旗与计数器组合里，哪些组合合法只写在注释的正确性
// 证明里（新增状态时编译器与测试都无从穷举）。现改为：state 容器唯一存真 + 相位读数
// 派生 + 全部转移经 transition（合法性表 isLegalTransition，非法即拒并 error 留痕）。

/**
 * 相位（child 侧在做什么）——由状态载荷派生（见 phaseOf），不单独存（免得两份真相）：
 * - 'idle'     无 child、无在途轮、无挂起重启
 * - 'starting' 在途启动轮（fork+握手）未收口。换轮清旧与「child 接管后收口前最后一拍」
 *              期间当值 child 与在途轮并存，仍读 'starting'：启动通道占用才是 /
 *              复用语义的判据（旧 starting 通道口径不变）
 * - 'running'  当值 child 已握手完成（无在途轮）
 * - 'backoff'  崩溃后退避等待（重启定时器在途，无 child 无在途轮）
 */
export type ManagerPhase = 'idle' | 'starting' | 'running' | 'backoff'

/**
 * 停机面三值——取代旧 shutdownStarted（主动 kill 标记）+ shuttingDown（停机生命周期门）
 * 两布尔旗：两旗 4 种组合里「门置位而标记未置位」不可达却可被表达，现由类型排除。
 * - 'none'     正常运行：当值 child 的 exit 属意外，可排程自动重启
 * - 'marked'   主动 kill 标记（stopChild / killNow / 换轮清旧）：exit 属预期，不重启
 * - 'shutting' 停机流程在途（含 marked 语义）：start 入口 fail-closed、shutdown 幂等
 */
export type StopMode = 'none' | 'marked' | 'shutting'

/** 转移事件——相位载荷/停机面的每一次变更都必须以一者表达（载荷见 TransitionCall） */
export type ManagerEvent =
  | 'round-open' // 开在途轮（显式 start / 自动重启 / 自愈恢复）
  | 'round-close' // 在途轮收口（调用方 finally 单点）
  | 'child-up' // 握手完成、child 接管当值位
  | 'child-down' // 当值 child 退出（预期与否由停机面分派，见 launch 退出监听）
  | 'backoff-arm' // 排程自动重启（退避定时器武装）
  | 'backoff-cancel' // 作废挂起重启（换轮/停机/自愈；无定时器时为无害 no-op）
  | 'backoff-fire' // 退避定时器到点（摘除定时器）
  | 'stop-mark' // 置主动 kill 标记（幂等）
  | 'stop-clear' // 复位主动 kill 标记（显式新生命周期复位单点）
  | 'shutdown-open' // 停机流程在途
  | 'shutdown-close' // 停机流程收口（主动 kill 标记保留）

/** 状态机读数（转移轨迹与矩阵测试的观测面） */
export interface ManagerStateSnapshot {
  phase: ManagerPhase
  stop: StopMode
}

/** 转移轨迹（deps.onTransition 载荷）：legal=false = 非法转移被拒（此时 to === from） */
export interface TransitionTrace {
  event: ManagerEvent
  from: ManagerStateSnapshot
  to: ManagerStateSnapshot
  legal: boolean
}

/**
 * 转移表（机器可读形态，与 transition 的 switch 一一对应）：事件 × 前置（相位, 停机面）
 * → 是否合法。非法不是静默返回：transition 记 error 留痕并拒绝该转移（状态不变）。
 * 本表外露供转移矩阵测试直测——表的边界即状态机契约（新增状态必同时补本表与 switch，
 * 穷尽 switch 有编译器兜底）。
 */
export function isLegalTransition(ev: ManagerEvent, phase: ManagerPhase, stop: StopMode): boolean {
  switch (ev) {
    // 开轮：空闲、换轮（当值 child 待清）、退避到点（重启/自愈）都能开；'starting'
    // 表示在途轮已占（start 的复用与已在入口拦下）→ 不许双开
    case 'round-open':
      return phase === 'idle' || phase === 'running' || phase === 'backoff'
    // 收口：只有轮在途（含 child 接管后收口前一拍）才可收口，重复收口即非法
    case 'round-close':
      return phase === 'starting'
    // 接管：只在轮内（fork 后握手成功才谈得上）
    case 'child-up':
      return phase === 'starting'
    // 退出：当值 child 正常在跑，或换轮清旧期（轮在途、旧 child 仍是当值）
    case 'child-down':
      return phase === 'running' || phase === 'starting'
    // 排程：崩溃路径（child-down 后已回 'idle'）、重启握手失败续排（轮未收口）、封顶
    // 决断选重启（等待期作者可能已用显式 start 起了新生命周期）；'backoff' = 已有挂起
    // 重启（旧 restartTimer 非空即不双排），停机面非 'none' 即不排
    case 'backoff-arm':
      return stop === 'none' && (phase === 'idle' || phase === 'starting' || phase === 'running')
    // 作废：任何相位/停机面都可能调用（无定时器时为无害 no-op）——换轮/停机/自愈三面
    case 'backoff-cancel':
      return true
    // 到点：定时器回调只可能来自 'backoff'（0ms 退避与轮收口同拍时读到 'starting'
    // ——见 phaseOf 的在途轮优先，故两相位都在表内）
    case 'backoff-fire':
      return phase === 'backoff' || phase === 'starting'
    // 主动 kill 标记：任何相位任何停机面都可置位（幂等；'shutting' 下保持流程门语义）
    case 'stop-mark':
      return true
    // 复位：停机流程在途时非法（/-——「shutdown 开始后绝不 fork 出存活
    // child」靠的就是这个复位，流程内把它拆掉即漏杀）
    case 'stop-clear':
      return stop !== 'shutting'
    // 停机流程：已在流程内即非法（shutdown 入口的幂等 early-return 拦下，双开不许可）
    case 'shutdown-open':
      return stop !== 'shutting'
    // 收口：只可能从流程内收口
    case 'shutdown-close':
      return stop === 'shutting'
  }
}

/** 在途启动轮——旧 starting/startingOpts/startingProc 三变量合一 */
interface StartRound {
  /** 关键 opts 快照（并发 start 复用前的一致性校验用） */
  opts: StartStudioServerOptions
  /** fork 句柄（fork 后回填；shutdown 短预算耗尽时 kill 链经此够到它） */
  proc: UtilityProcessLike | null
  /** 本轮 promise（开轮当拍回填、收口时随轮摘除；读侧经 roundPromise 守卫） */
  promise: Promise<number> | null
}

/**
 * 管理器状态（唯一可变真相源）——旧 12 个闭包变量收敛于此：相位载荷
 * （round/child/backoffTimer）+ 停机面 + 计数 + 最近成功面 + 两份正交数据。相位不入
 * 本对象（由载荷派生，见 phaseOf）。
 */
interface ManagerState {
  /** 在途启动轮（互斥通道 + 快照 + kill 句柄） */
  round: StartRound | null
  /** 当值 child（已握手完成、exit 监听已挂） */
  child: ActiveChild | null
  /** 挂起的自动重启定时器 */
  backoffTimer: NodeJS.Timeout | null
  /** 停机面三值（原 shutdownStarted + shuttingDown） */
  stop: StopMode
  /** 自动重启计数（当前生命周期内）。非相位派生项：跨相位存续的独立计数，故不入
   *  转移表；清零点 = 稳定窗口 / 显式新生命周期 / 封顶决断选重启（各处就地注释）。 */
  attempts: number
  /** 最近一次成功 fork 面（重启/自愈复刻：钉住端口 + 原 opts，前端同源） */
  lastBoot: { opts: StartStudioServerOptions; port: number } | null
  /** studioToken 内存值（启动读入一次，此后 fork 一律复用；与相位正交的数据） */
  token: string | null
  /** 停机收口等待者（restartPinned 有界等待；与相位正交的协调数据） */
  shutdownSettledWaiters: Array<() => void>
}

/** transition 实参：事件 + 该事件载荷（穷尽联合——载荷缺配/错配在编译期排除） */
type TransitionCall =
  | { ev: 'round-open'; opts: StartStudioServerOptions }
  | { ev: 'round-close' }
  | { ev: 'child-up'; child: ActiveChild; boot: { opts: StartStudioServerOptions; port: number } }
  | { ev: 'child-down' }
  | { ev: 'backoff-arm'; timer: NodeJS.Timeout }
  | { ev: 'backoff-cancel' }
  | { ev: 'backoff-fire' }
  | { ev: 'stop-mark' }
  | { ev: 'stop-clear' }
  | { ev: 'shutdown-open' }
  | { ev: 'shutdown-close' }

interface StudioServerManager {
  /** fork + 握手，resolve 实际监听端口（ready 消息回传）。旧 child 在途时先停旧再 fork；
   *  显式 start 开新生命周期（退避计数清零、挂起重启作废）。 */
  start(opts: StartStudioServerOptions): Promise<number>
  /** kill 当前 child 并等退出（bootstrap 重试清旧共用）；无 child 直通。主动停机：
   *  取消挂起重启 + 门置位（随后的 exit 不触发自动重启）。 */
  stopChild(): Promise<void>
  /**
   * （#35）：崩溃退出兜底用——不等待收口，对在途 child/在途
   * fork 同步发出 kill 信号（fire-and-forget，无 SIGKILL 升级——升级等待属 stopChild
   * 链，调用方即退无窗口可等）。uncaughtException 的 200ms backstop 到点时 stopChild
   * 可能仍在 settle 竞速窗（预算 2s）内、kill 尚未发出，裸 process.exit 会把 child
   * 留成孤儿。置位主动停机门（被杀 child 的 exit 不触发自动重启）+ 作废挂起重启。
   */
  killNow(): void
  /**
   * 优雅停机（before-quit 收尾）：下发 shutdown 指令 → shutdownStudio 落定 →
   * shutdown-done 回执 / 总超时（3.5s）/ exit 三路先到为准；窗口内未退则 kill 兜底。
   * 等在途启动（settleStarting）设短预算（缺省 2s），超时放弃等
   * 握手、直接 kill 在途 fork，不让用户点退出最坏挂 ~41s。
   * 幂等；与 stopChild 同属主动停机——均置停机面主动 kill 标记（批重启门消费）。
   */
  shutdown(): Promise<void>
  /**
   * session-end 观察窗自愈入口——win 上 OS 关机/注销被取消时
   * 进程仍存活，session-end 链已 shutdown 的 server 需显式拉回。复刻 doRestart 的
   * 钉住端口重启（前端恢复链同源：origin 不变，存活渲染层无缝续用），但作为
   * 显式新生命周期先复位「主动 kill 标记」（与 start 轮内复位点同
   * 语义——那是防「停机途中崩溃自动重启复活」的挡板，不该挡显式恢复）。
   * 停机流程仍在途不再立即返 null——有界等待停机收口后重试
   * 一次原路径（上限见 RESTART_SHUTDOWN_WAIT_MS / deps.restartShutdownWaitMs）；
   * 等待中或收口时本进程已入退出链（deps.isProcessExiting）或等待超时 → null，
   * 由调用方留痕。无历史 fork 面（从未 start 过）→ null。
   */
  restartPinned(): Promise<number | null>
  /** 是否有已握手完成的 child 在跑 */
  isRunning(): boolean
  /** 是否有崩溃退避后排程、尚未落地的挂起自动重启（main 侧「关旧」判据补充——
   *  child 已崩但重启在途时 isRunning 为 false，仅凭它会漏关并漏取消挂起重启） */
  hasPendingRestart(): boolean
}

/**
 * studioToken 首启生成 / 原子持久化 / 启动读入内存一次（A， + 二轮）：
 * - 跨崩溃重启（本进程内）与跨 main 重启（relaunch）token 均不变——前端全同源
 *   相对路径 + token 仅挂载时取一次（client.ts ），换代即写/SSE/心跳永久 403；
 * - 文件损坏/缺失 → 重生成覆写（窄边：仅影响下次启动，本次内存值继续用）；
 * - 安全口径不降级（ee- 拍板）：token 不承诺防本机进程，mode 0o600 防的
 *   仍是远端网页驱动（网页读不了本地文件）。
 */
function loadOrCreateStudioToken(userDataPath: string): string {
  const fp = tokenFilePath(userDataPath)
  try {
    const raw = JSON.parse(readFileSync(fp, 'utf-8')) as { token?: unknown }
    if (typeof raw.token === 'string' && raw.token.length > 0) return raw.token
  } catch {
    /* 缺失/损坏 → 落到重生成 */
  }
  const token = randomUUID()
  atomicWriteFile(fp, JSON.stringify({ token } as { token: string }, null, 2), { mode: 0o600 })
  return token
}

function tokenFilePath(userDataPath: string): string {
  return join(userDataPath, 'studio-token.json')
}

function entryModulePath(): string {
  // dist/desktop/server-manager.js 与 server-utility.js 同目录（tsup 单 entry 集）
  return join(dirname(fileURLToPath(import.meta.url)), 'server-utility.js')
}

/** （评审）：管理器只读配置——deps 缺省注入后的组装结果
 *  （唯一组装点 = resolveManagerConfig）。导出供直测（缺省值表驱动用例）。 */
export interface ManagerConfig {
  forkImpl: (modulePath: string, args: string[], options: ForkOptionsLike) => UtilityProcessLike
  logger: LogLike
  shutdownTotalMs: number
  shutdownSettleBudgetMs: number
  killWaitMs: number
  backoffMs: readonly number[]
  stabilityResetMs: number
  restartShutdownWaitMs: number
  isProcessExiting: () => boolean
  onRestarted?: (port: number) => void
  loadOsKek: (userDataPath: string) => Buffer | null
  /** 状态机转移轨迹钩子（缺省无操作；仅观测，不参与决策） */
  onTransition?: (trace: TransitionTrace) => void
  /** 3 次自动重启耗尽后的用户决断（缺省无 → 走 quit 兜底留痕） */
  onRestartExhausted?: () => 'restart' | 'quit' | Promise<'restart' | 'quit'>
}

/** 管理器运行上下文——只读配置 + 唯一可变状态源。各单元显式传参
 *  （不再各自闭包捕获 12 个变量），相位/停机面仍只经 transition 变更。 */
interface ManagerCtx {
  cfg: ManagerConfig
  state: ManagerState
}

/** 组装依赖（拆分单元之一）——deps 缺省注入单点，缺省真件只在此出现。 */
export function resolveManagerConfig(deps: ServerManagerDeps = {}): ManagerConfig {
  return {
    forkImpl: deps.fork ?? ((modulePath, args, options) => utilityProcess.fork(modulePath, args, options)),
    logger: deps.logger ?? log,
    shutdownTotalMs: deps.shutdownTotalMs ?? SHUTDOWN_TOTAL_TIMEOUT_MS,
    // shutdown 等 settleStarting 的短预算（缺省见 SHUTDOWN_SETTLE_BUDGET_MS 头注）
    shutdownSettleBudgetMs: deps.shutdownSettleBudgetMs ?? SHUTDOWN_SETTLE_BUDGET_MS,
    killWaitMs: deps.killWaitMs ?? KILL_WAIT_TIMEOUT_MS,
    backoffMs: deps.backoffMs ?? RESTART_BACKOFF_MS,
    stabilityResetMs: deps.stabilityResetMs ?? STABILITY_RESET_MS,
    // 自愈等停机收口上限 + 本进程退出探测（缺省见常量/依赖注释）
    restartShutdownWaitMs: deps.restartShutdownWaitMs ?? RESTART_SHUTDOWN_WAIT_MS,
    isProcessExiting: deps.isProcessExiting ?? (() => false),
    // （§四.3）：重启成功广播钩子（缺省无操作）
    onRestarted: deps.onRestarted,
    // 0918三拍板批（KEK v2）：OS 凭据通道 IKM 装置（缺省真件；不可用面在装置内回落 null）
    loadOsKek: deps.loadOsKek ?? loadOrGenerateOsKek,
    onTransition: deps.onTransition,
    onRestartExhausted: deps.onRestartExhausted,
  }
}

/**
 * 管理器状态容器（唯一可变真相源）——旧 12 个闭包变量收敛于此。旧注释里
 * 那份「多旗组合的正确性证明」由本对象 + phaseOf + isLegalTransition 取代：合法
 * 组合即「相位 × 停机面」的派生读数（稀疏三类），非法组合在 transition 处被拒。
 * 字段语义见 ManagerState 头注；的 opts 快照、的 fork 句柄、的
 * starting 通道分别落在 round 的 opts/proc/promise 上（不再是三个各自可空变量）。
 */
function createManagerState(): ManagerState {
  return {
    round: null,
    child: null,
    backoffTimer: null,
    stop: 'none',
    attempts: 0,
    lastBoot: null,
    token: null,
    shutdownSettledWaiters: [],
  }
}

/** 相位读数（派生视图，无独立真相）——在途轮 > 挂起重启 > 当值 child > 空闲 */
function phaseOf(state: ManagerState): ManagerPhase {
  if (state.round) return 'starting'
  if (state.backoffTimer) return 'backoff'
  if (state.child) return 'running'
  return 'idle'
}

/** 主动 kill 标记（原 shutdownStarted）：当值 child 的 exit 属预期，不触发自动重启 */
function killMarked(ctx: ManagerCtx): boolean {
  return ctx.state.stop !== 'none'
}

/** 停机流程在途（原 shuttingDown）：start 入口 fail-closed / shutdown 幂等门 */
function isShutting(ctx: ManagerCtx): boolean {
  return ctx.state.stop === 'shutting'
}

/** 状态机读数快照（转移轨迹与测试用） */
function stateSnapshot(state: ManagerState): ManagerStateSnapshot {
  return { phase: phaseOf(state), stop: state.stop }
}

/**
 * 唯一转移点——合法性判定（isLegalTransition，正本在模块级表）与
 * 载荷/停机面变更同处一函数；非法即 error 留痕并拒绝（状态不变，不静默放行）。
 * 除本函数外不得改 state 的相位载荷与停机面（attempts 是计数，见 ManagerState 注）。
 */
function transition(ctx: ManagerCtx, call: TransitionCall): void {
  const { state } = ctx
  const from = stateSnapshot(state)
  if (!isLegalTransition(call.ev, from.phase, from.stop)) {
    ctx.cfg.logger.error(
      'server-manager',
      `状态机非法转移已拒绝（R0916-7-P3-17）：${call.ev} @ phase=${from.phase} stop=${from.stop}（状态不变）`,
    )
    reportTransition(ctx, call.ev, from, from, false)
    return
  }
  switch (call.ev) {
    case 'round-open':
      state.round = { opts: call.opts, proc: null, promise: null }
      break
    case 'round-close':
      state.round = null
      break
    case 'child-up':
      state.child = call.child
      state.lastBoot = call.boot
      break
    case 'child-down':
      state.child = null
      break
    case 'backoff-arm':
      state.backoffTimer = call.timer
      break
    case 'backoff-cancel':
      if (state.backoffTimer) {
        clearTimeout(state.backoffTimer)
        state.backoffTimer = null
      }
      break
    case 'backoff-fire':
      state.backoffTimer = null
      break
    case 'stop-mark':
      if (state.stop === 'none') state.stop = 'marked' // 'shutting' 下保持流程门语义
      break
    case 'stop-clear':
      state.stop = 'none'
      break
    case 'shutdown-open':
      state.stop = 'shutting'
      break
    case 'shutdown-close':
      state.stop = 'marked' // 主动 kill 标记不随流程收口复位（原 shutdownStarted 语义）
      break
  }
  reportTransition(ctx, call.ev, from, stateSnapshot(state), true)
}

/** 转移轨迹外露（缺省无操作）：纯观测面——钩子抛错被隔离，不得反噬状态机 */
function reportTransition(
  ctx: ManagerCtx,
  event: ManagerEvent,
  from: ManagerStateSnapshot,
  to: ManagerStateSnapshot,
  legal: boolean,
): void {
  const onTransition = ctx.cfg.onTransition
  if (!onTransition) return
  try {
    onTransition({ event, from, to, legal })
  } catch (e) {
    ctx.cfg.logger.warn('server-manager', 'onTransition 状态机轨迹钩子抛错（已忽略）', e)
  }
}

/**
 * 开轮（唯一入口）——转移落位后回传轮对象（调用方随即回填 promise
 * 并 await）。开轮被状态机拒绝（在途轮已占）即无轮可回传：显式抛，不 fork 无主 child
 * （调用点三处复用守卫已拦，此抛只在状态机不变量被破坏时到场）。
 */
function openRound(ctx: ManagerCtx, opts: StartStudioServerOptions): StartRound {
  transition(ctx, { ev: 'round-open', opts })
  const round = ctx.state.round
  if (!round) throw new Error('R0916-7-P3-17：在途轮已占，开轮被拒（拒绝 fork 无主 child）')
  return round
}

/** 在途轮 promise 读数：开轮与回填同拍（无 await 缝），空即状态机不变量被破坏 */
function roundPromise(round: StartRound): Promise<number> {
  if (!round.promise) throw new Error('R0916-7-P3-17：在途轮 promise 未回填（不变量破坏）')
  return round.promise
}

function cancelPendingRestart(ctx: ManagerCtx): void {
  transition(ctx, { ev: 'backoff-cancel' })
}

/**
 * （修复批）：预算耗尽时对在途 fork 的就地 kill 收口
 * （stopChild / shutdown 两段逐字同构块收拢为局部闭包，行为零变化）——句柄快照 +
 * once('exit') 等待 + kill + killProcAwaitEscalating 纪律（killWaitMs 等待 + SIGKILL
 * 升级）。无在途 fork（轮内句柄已收口）直通；`!settled && state.round?.proc` 守卫留在
 * 调用点（settled 属各自 race 局部量）。
 */
async function killStartingProc(ctx: ManagerCtx, context: string): Promise<void> {
  const proc = ctx.state.round?.proc ?? null
  if (!proc) return
  const exited = onceExit(proc)
  proc.kill()
  await killProcAwaitEscalating(proc, exited, context, ctx.cfg.killWaitMs, ctx.cfg.logger)
}

/** once('exit') 等待面（kill 前挂监听，防同步 exit 漏窗） */
function onceExit(proc: UtilityProcessLike): Promise<void> {
  return new Promise<void>((resolveExit) => {
    proc.once('exit', () => resolveExit())
  })
}

/**
 * 子进程 argv 组装（launch 纯前置，独立可测）：token 不经 argv
 * （本机 ps 可见）——改经 env CLW_STUDIO_TOKEN 注入（server-boot parseServerArgs
 * 读取侧同步切 env），argv 面不再出现 token。
 */
export function buildChildArgs(opts: StartStudioServerOptions, portArg: string): string[] {
  const args: string[] = ['--user-data', opts.userDataPath, '--port', portArg]
  if (opts.workDir) args.push('--dir', opts.workDir)
  if (opts.book) args.push('--book', opts.book)
  if (opts.mirrorConsole) args.push('--mirror-console')
  return args
}

/**
 * 子进程 env 组装（launch 纯前置，独立可测）：宿主 process.env 展开拷贝（不污染 main
 * 自身 process.env），受控键逐键大小写不敏感清除后按入参注入受控值。token/osKek 由
 * 调用方读取后传入（读写状态的时序留在 launch），本函数无副作用。
 */
export function buildChildEnv(
  opts: StartStudioServerOptions,
  token: string,
  osKek: Buffer | null,
): Record<string, string | undefined> {
  // stdio:pipe + CLW_LOG_STDOUT=1（§3.5 单写者）：child 日志只走 stdout JSON 行，
  // 由 main 收行重发落盘；env 展开拷贝，不污染 main 自身 process.env
  // 宿主 process.env 残留的 CLW_STUDIO_TOKEN 先在拷贝上显式
  // delete 再注入受控值——不依赖对象字面量后键覆盖的隐式顺序，防旧值穿透（仅动
  // 拷贝，process.env 本身不动）
  const childEnv: Record<string, string | undefined> = { ...process.env }
  // （win 平台专项）：win 环境变量名不区分大小写、保序保留——裸 delete
  // 认不到宿主残留的小写/混写变体（clw_studio_token），子进程 env block 会出现
  // 双重键、取值未指定（命中旧值 = 全请求 403）。逐键大小写不敏感清除后再注入。
  // 清除面补 CLW_LOG_STDOUT——下方注入 CLW_LOG_STDOUT=1，若宿主
  // 残留混写变体（clw_log_stdout）同样双键穿透，child 日志形态被旧值劫持。
  // 清除面再补 CLW_DEV_UI / CLW_DEV_CORS / CLWRITING_RESOURCES_DIR
  // ——防宿主残留泄漏进打包 child：前两者会让 child 的 Origin 白名单放宽放行 5173
  // （server/index.ts dev 注入面，本应只属于 scripts/dev-api.ts 的独立进程）；后者
  // 会把 child 捆绑资源根钉到宿主目录（fs/resources.ts 无 electron 依赖、打包态检查
  // 不可达，fork 前剥除 = child 回落模块相对推导 asar 内资源）。合法 dev 链路不经本
  // manager 携带这些变量（devUi 态 main 不 fork server；dev:api 是独立进程自带 env），
  // 剥除无旁损。
  // 0918三拍板批（KEK v2）：清除面再补 CLW_OS_KEK——宿主残留会绕过下方受控注入
  //（旧 IKM 穿透 = v2 vault 解锁失败或错通道），同款逐键清洗后注入。
  // 阶段 53 ：清除面再补 CLW_APP_VERSION——宿主残留版本号会让更新检查比错基准
  //（旧版本被判「已是最新」漏提示，或高版本造出假提示），同款清洗后按 opts 注入。
  for (const k of Object.keys(childEnv)) {
    const ku = k.toUpperCase()
    if (
      ku === 'CLW_STUDIO_TOKEN' ||
      ku === 'CLW_LOG_STDOUT' ||
      ku === 'CLW_DEV_UI' ||
      ku === 'CLW_DEV_CORS' ||
      ku === 'CLWRITING_RESOURCES_DIR' ||
      ku === 'CLW_OS_KEK' ||
      ku === 'CLW_APP_VERSION'
    ) {
      delete childEnv[k]
    }
  }
  childEnv['CLW_STUDIO_TOKEN'] = token
  childEnv['CLW_LOG_STDOUT'] = '1'
  // 阶段 53 ：版本号经 env 下发（缺省不注入——child 回落读 package.json）
  if (opts.appVersion) childEnv['CLW_APP_VERSION'] = opts.appVersion
  // 0918三拍板批（KEK v2）：OS 通道 IKM 经 env 注入（safeStorage 只在主进程可用，
  // 子进程按 hex 接收；null = 无 OS 通道，子进程回落 v1 内置通道语义）
  if (osKek) childEnv['CLW_OS_KEK'] = osKek.toString('hex')
  return childEnv
}

/**
 * fork + 握手 + 接线（start 与内部重启共用；轮对象由调用方开好，本函数只填轮内载荷）。
 * portArg：start 传 '0'（OS 分配）；重启传钉住端口字符串（前端恢复链同源）。
 * 成功后登记当值 child 与最近成功 boot 面、挂持久 exit 监听（非主动停机 → 排程重启）、
 * 起稳定窗口计时（本轮 child 存活过窗口才清零——回调时校验当值身份，
 * 迟到的旧 child exit 不会误清新一轮计数）。
 */
async function launch(ctx: ManagerCtx, round: StartRound, portArg: string): Promise<number> {
  const { cfg, state } = ctx
  const opts = round.opts
  if (state.token === null) state.token = loadOrCreateStudioToken(opts.userDataPath)
  const args = buildChildArgs(opts, portArg)
  const proc = cfg.forkImpl(entryModulePath(), args, {
    serviceName: STUDIO_SERVICE_NAME,
    stdio: 'pipe',
    env: buildChildEnv(opts, state.token, cfg.loadOsKek(opts.userDataPath)),
  })
  // fork 后发现停机已置位 → 立即杀掉新 child 并按启动失败收口。
  // 在途轮（启动通道）的握手窗口内 shutdown/stopChild 落地时，
  // shutdown 侧 settleStarting 只能等到 handshake 完成——fork 即杀把窗口收窄到
  // 「已 fork 未检查」的同步缝隙，新 child 不再漏杀成孤儿（优雅停机面收口）。
  // （#34）：kill 收编 killProcAwaitEscalating 同款等待/升级
  // 纪律（TERM→等 killWaitMs→SIGKILL，握手超时/boot-error 分支同款）——此前
  // fire-and-forget，SIGTERM 被吞（child 卡死在不可中断调用）时新 child 在停机链上
  // 漏杀成孤儿。与既有 stop 路径的差异点：收口形态仍是启动失败——等杀链走完再抛
  // ServerBootError('SHUTDOWN')（握手超时分支同款时序），settleStarting 侧经
  // settle/catch 照常落定，启动期其余语义不变。
  if (killMarked(ctx)) {
    const exited = onceExit(proc)
    proc.kill()
    await killProcAwaitEscalating(proc, exited, 'studio server 停机期在途 fork 收口', cfg.killWaitMs, cfg.logger)
    throw new ServerBootError('SHUTDOWN', 'studio server 启动途中收到停机指令，已中止新 child')
  }
  // 在途 fork 句柄登记进本轮（与轮同生命周期，调用方 finally 收口
  // 时随轮摘除）——shutdown 短预算耗尽时 kill 链经此够到它
  round.proc = proc
  forwardChildStdio(proc, cfg.logger) // 握手前接线——boot 期日志不丢
  // （GLM-5.3 修复批）：utilityProcess 'error' 必监听
  // ——V8 FatalError/OOM/spawn 失败等异常终止经该事件抛诊断，EventEmitter 语义下无监听
  // 即 uncaughtException 崩主进程；此前既不监听也不留痕，child 静默消失只剩 restart 链
  // 兜底重启，根因（V8 级崩溃原因）永久丢失。持久监听随 child 消亡，诊断进档；握手期
  // 的 'error' 另由 handshake 的监听快失败（不必等满 30s 超时），两监听并存不冲突
  //（handshake settle 有 settled 单飞闸，本监听只记日志不参与结算）。
  proc.on('error', (type: string, location: string, report: string) => {
    cfg.logger.error(
      'server-manager',
      `studio server utilityProcess 异常终止（error 事件：${type}${location ? ` @ ${location}` : ''}）`,
      report,
    )
  })
  const port = await handshake(proc, cfg.logger, cfg.killWaitMs)
  // 稳定窗口计时（unref 不拖退出）：到点仍是当值 child 才清零
  const stabilityTimer = setTimeout(() => {
    if (state.child?.proc === proc) state.attempts = 0
  }, cfg.stabilityResetMs)
  stabilityTimer.unref()
  const exited = new Promise<void>((resolveExit) => {
    proc.once('exit', () => {
      clearTimeout(stabilityTimer)
      const wasActive = state.child?.proc === proc
      if (wasActive) transition(ctx, { ev: 'child-down' })
      resolveExit()
      // 非主动停机且确系当值 child 崩溃 → 排程重启（迟到旧 exit 不触发）
      if (wasActive && !killMarked(ctx)) scheduleRestart(ctx)
    })
  })
  // 接管（child 当值 + 最近成功 boot 面，重启/自愈复刻用）——同一转移内落位
  transition(ctx, { ev: 'child-up', child: { proc, port, exited }, boot: { opts, port } })
  return port
}

/** 退避表读数（attempts 为「即将进行的第几次」）：表尾夹取 + 空表回落到 0ms 立即重试 */
export function nextBackoffMs(attempts: number, backoffMs: readonly number[]): number {
  return backoffMs[Math.min(attempts - 1, backoffMs.length - 1)] ?? 0
}

function scheduleRestart(ctx: ManagerCtx): void {
  const { cfg, state } = ctx
  if (killMarked(ctx) || state.backoffTimer) return // 主动停机不重启 / 已有挂起重启不双排
  if (state.attempts >= RESTART_MAX_ATTEMPTS) {
    cfg.logger.error('server-manager', `studio server 连续崩溃：${RESTART_MAX_ATTEMPTS} 次自动重启后仍异常，转用户决断`)
    // （-②）：决断可能异步（异步对话框）——exit 回调不等它，决断到达
    // 前不重启不退出；期间 active 已空、无新 exit 事件，无重入面
    // （修复批）：决断链补 .catch——异步决断 reject
    // （对话框链异常等）此前无接手即成 unhandledRejection；catch 记错误日志后走兜底
    // 'quit' 语义（本模块的 quit 缺省 = 不再自动重启，真退出由 main 侧执行，deps 无
    // quit 钩子可调——保持进程现状不重启即该语义的兜底形态）。
    // （六轮修复批）：缺省 'quit' 臂补显式 error
    // 留痕——本模块 deps 无 quit 钩子可调（真退出由 main 侧执行），「quit 语义」的实际
    // 形态 = 保持进程现状、不再自动重启；生产 main.ts 已接线 onRestartExhausted，此臂
    // 只在接线缺失/异常时到场，届时进程停在「无 server、无提示」态。此前该降级态只由
    // 上面那条「连续崩溃 3 次」日志间接指示，作者无从区分「正在重启」与「已放弃」。
    // 现两条路径（无钩子 / 决断为 quit）各补一条终态 error，与决策表口径「API 永久不可用」
    // 显式对齐（评审的取法：语义不变，只让降级态可感知）。
    const quitFallback = (why: string): void => {
      cfg.logger.error(
        'server-manager',
        `studio server 已放弃自动重启（${why}）：进程保持运行但本地 API 永久不可用，请重启应用。`,
      )
    }
    if (!cfg.onRestartExhausted) {
      quitFallback('无崩溃封顶决断钩子')
      return
    }
    void Promise.resolve(cfg.onRestartExhausted())
      .then((choice) => {
        if (choice === 'restart') {
          state.attempts = 0 // 人工重启计一次全新周期
          scheduleRestart(ctx)
          return
        }
        quitFallback('作者决断 quit')
      })
      .catch((e) => {
        cfg.logger.error('server-manager', '崩溃封顶决断回调失败，按兜底 quit 语义收口（不再自动重启）', e)
        quitFallback('决断回调异常')
      })
    return
  }
  state.attempts++
  const waitMs = nextBackoffMs(state.attempts, cfg.backoffMs)
  cfg.logger.warn(
    'server-manager',
    `studio server 子进程异常退出，${waitMs}ms 后自动重启（第 ${state.attempts}/${RESTART_MAX_ATTEMPTS} 次）`,
  )
  const timer = setTimeout(() => {
    transition(ctx, { ev: 'backoff-fire' }) // 到点先摘定时器（相位回派生值），再进重启判定
    void doRestart(ctx)
  }, waitMs)
  timer.unref()
  transition(ctx, { ev: 'backoff-arm', timer })
}

/**
 * doRestart / restartPinned 的同构核心收敛——
 * cancelPendingRestart →（调用方停机面/计数复位钩子）→ 开轮占位 launch（钉住端口）
 * → 成功 info + onRestarted 广播隔离 try/catch（-3：钩子抛错不得伪装成握手失败）
 * → 失败 failLog → finally 轮收口。握手失败返回 null（调用方各自处置：doRestart
 * 按退避续排 / restartPinned 契约返 null）。
 * 红线核对：重启计数（本函数不触碰 state.attempts——restartPinned 的清零经 beforeLaunch
 * 钩子保持在原开轮前的时序点）、钩子时序、warn 文案逐位不变。doRestart 侧新增的
 * cancelPendingRestart 在原调用形态下恒 no-op（退避定时器回调已先摘除），与
 * restartPinned 原显式取消合一后语义不变。
 */
async function launchPinned(
  ctx: ManagerCtx,
  boot: { opts: StartStudioServerOptions; port: number },
  hooks: {
    /** 开轮前调用（restartPinned 的停机面复位/计数清零原序保留） */
    beforeLaunch?: () => void
    successLog: (port: number) => void
    failLog: (e: unknown) => void
  },
): Promise<number | null> {
  cancelPendingRestart(ctx)
  hooks.beforeLaunch?.()
  // 重启全程占在途轮互斥通道——开轮后并发 start 同参数复用
  // 在途重启轮（含钉住端口语义）、参数不一致沿用 fail-closed reject；finally
  // 收口归还通道。
  const round = openRound(ctx, boot.opts)
  round.promise = (async () => launch(ctx, round, String(boot.port)))()
  try {
    const got = await roundPromise(round)
    hooks.successLog(got)
    // 广播钩子隔离——钩子抛错不得伪装成「握手失败」再排一轮重启（服务实际已在跑）
    try {
      ctx.cfg.onRestarted?.(got)
    } catch (e) {
      ctx.cfg.logger.warn('server-manager', 'onRestarted 广播钩子抛错（已忽略）', e)
    }
    return got
  } catch (e) {
    hooks.failLog(e)
    return null
  } finally {
    transition(ctx, { ev: 'round-close' }) // 轮收口（含在途 fork 句柄）同点归还
  }
}

/** 退避到点后的自动重启：在途轮在则复用它（失败已由该轮自身路径收口），否则复刻最近成功 boot 面 */
async function doRestart(ctx: ManagerCtx): Promise<void> {
  const { cfg, state } = ctx
  if (killMarked(ctx)) return // 等待窗口内被停机
  // （修复批）：在途不覆写—— 注释自认
  // 「doRestart 不查 starting 直接覆写通道」：崩溃风暴对话框等待期（onRestartExhausted
  // 异步决断在途，-② 起）并发 restartPinned 自愈握手在途时，0ms 退避触发的
  // doRestart 会覆写在途轮——先落定方的 finally 清错通道与 fork 句柄、launch 双 fork
  // 竞逐当值位（输者孤儿）。对齐 start 复用口径：轮被占即复用在途轮（其自身 catch
  // 已按退避续排 / 留痕），本函数不再排新轮。
  const pending = state.round
  if (pending) {
    await roundPromise(pending).catch(() => {}) // 在途轮落定即本函数语义完成，失败已由在途轮自身路径收口
    return
  }
  const boot = state.lastBoot
  if (!boot) return
  await launchPinned(ctx, boot, {
    successLog: (got) => cfg.logger.info('server-manager', `studio server 已自动重启（端口 ${got} 钉住）`),
    failLog: (e) => {
      // 重启期握手失败（EXIT/EADDRINUSE 残留端口等）按退避继续（§3.4 时序 3）
      cfg.logger.error('server-manager', '自动重启握手失败，按退避序列继续', e)
      scheduleRestart(ctx)
    },
  })
}

/**
 * 等在途 start/自动重启（在途轮通道）落定再判当值 child。
 * 握手窗口内当值位为空，shutdown/stopChild 只看当值位会让刚 fork 的 child
 * 收不到停机指令只能硬杀（在途编排 abort + session/end 落库丢失）。握手失败
 * （boot-error/EXIT）catch 吞掉——那是启动失败路径，继续停机面即可。
 */
async function settleStarting(ctx: ManagerCtx, source: string): Promise<void> {
  const pending = ctx.state.round?.promise
  if (!pending) return
  try {
    await pending
  } catch (e) {
    ctx.cfg.logger.warn('server-manager', `${source}：在途启动握手失败（已忽略，继续停机）`, e)
  }
}

/** stopChild 核心（kill + 等退出）；start 的换轮路径直接用（此时在途轮是 start
 *  自身 IIFE 的 promise——公共 stopChild 的 settleStarting 会 await 自己死锁）。 */
async function stopActiveChild(ctx: ManagerCtx): Promise<void> {
  const { state } = ctx
  const current = state.child
  cancelPendingRestart(ctx)
  if (!current) return
  transition(ctx, { ev: 'stop-mark' }) // 主动 kill：随后的 exit 是预期收口，不触发重启
  current.proc.kill()
  // SIGTERM 被吞的兜底：起超时升级 SIGKILL 强杀（退出事件迟到时当值位已由
  // exit 监听清空，语义不变）；无 pid / 升级失败回落「超时放行」
  // 主体在模块级 killProcAwaitEscalating——握手超时路径（模块级
  // handshake 够不着工厂闭包）同用一套 kill+等退出+升级纪律，不再各写一份。
  await killProcAwaitEscalating(current.proc, current.exited, 'stopChild', ctx.cfg.killWaitMs, ctx.cfg.logger)
}

/**
 * （#35）：killNow 的实现——同步对在途轮 fork/当值 child 发 kill
 * 信号后立即返回（不等待退出、无升级）。握手已落定而轮未收口的窄窗内轮句柄与当值
 * child 同指一个 child，双 kill 对已死句柄为无害幂等。
 */
function killNow(ctx: ManagerCtx): void {
  cancelPendingRestart(ctx)
  transition(ctx, { ev: 'stop-mark' }) // 被杀 child 的 exit 不触发自动重启
  ctx.state.round?.proc?.kill()
  ctx.state.child?.proc.kill()
}

/** stopChild：置主动 kill 标记 → 短预算等在途轮落定（超时则就地 kill 在途 fork）→ 停当值 child */
async function stopChildImpl(ctx: ManagerCtx): Promise<void> {
  const { cfg, state } = ctx
  // （评审四十九轮）：主动 kill 标记先置位（同 shutdown 入口形态）——在途 fork
  // 若恰在预算窗内完成握手后被就地 kill，其 exit 不会误触自动重启（doRestart
  // catch 的 scheduleRestart 与 launch 的 exit 监听都消费此标记）。幂等：stopActiveChild
  // 的置位与 start 轮内复位点的语义不受影响（stopChild 后的 start 换轮照常放行）。
  transition(ctx, { ev: 'stop-mark' })
  // 在途 start/自动重启先落定（catch 握手失败）再判当值 child——
  // 握手窗口内当值位为空，只看它会让刚 fork 的 child 漏杀成孤儿。
  // （评审四十九轮）：settleStarting 纳入短预算 race，与 shutdown 的
  // 形态对齐——此前裸 await 在握手挂起时最坏 HANDSHAKE_TIMEOUT_MS(30s) + kill
  // 升级 2s×2 才落定（崩溃重启链上的 bootstrap 重试最坏阻塞用户 ~34s 无响应）。
  // 预算内收口（正常握手毫秒级）语义不变；超时即放弃等握手，下方对在途 fork
  // 直接 kill 收口。settleStarting 内部 catch 握手失败永不 reject，输掉的分支在
  // 后台自行落定、无未处理拒绝面。
  const settled = await Promise.race([
    settleStarting(ctx, 'stopChild').then(() => true),
    delay(cfg.shutdownSettleBudgetMs).then(() => false),
  ])
  // （评审四十九轮）：预算耗尽且握手未收口——在途 fork 不再等 30s 握手超时，
  // 就地 kill + 等退出收口（killProcAwaitEscalating 纪律原样复用：killWaitMs 等待
  // + SIGKILL 升级，本段不新增等待语义）。settled=true 的空当值位属握手已失败/
  // child 已退形态，其自身路径已收口，此处无需动作。
  // 同构块收拢为 killStartingProc（行为零变化）。
  if (!settled && state.round?.proc) {
    await killStartingProc(ctx, 'stopChild 在途 fork 收口')
  }
  await stopActiveChild(ctx)
}

/** 启动（在途轮唯一入口 + 并发复用 + 停机门 fail-closed） */
async function startServer(ctx: ManagerCtx, opts: StartStudioServerOptions): Promise<number> {
  const { cfg, state } = ctx
  // 停机流程进行中 start fail-closed 拒绝—— 的注释与复位只覆盖
  // 「shutdown 先于 start 开始」的正向时序；反向时序（shutdown 已置位并停驻 kill/exit
  // 等待点，此时无在途轮）下 start 进入会在复位点同步清掉主动 kill 标记，
  // launch 的 fork 后检查失守 → 新 child 在停机流程中途存活。现状唯一调用链
  // bootstrapRunner 有守卫挡住、不可达——本修复把「靠调用纪律」变成机制（与
  // 参数不一致拒绝同口径）。注意用独立的停机流程门（stop='shutting'）：主动 kill
  // 标记还承载「停旧不重启」语义（stopActiveChild 置位），stopChild 之后的 start
  // 换轮必须放行，不能一并拒绝。
  if (isShutting(ctx)) {
    const err = new Error('停机流程进行中，拒绝 start（shutdown 已置位）——请等待停机完成')
    cfg.logger.warn('server-manager', '停机中收到 start，fail-closed 拒绝', err)
    return Promise.reject(err)
  }
  const pending = state.round
  if (pending) {
    // 并发 start 复用同一轮前校验关键 opts 一致（dir/user-data/
    // book/mirror-console）——不一致 fail-closed reject，不静默拿前者配置吞没后到调用方
    const s = pending.opts
    if (
      s &&
      (s.workDir !== opts.workDir ||
        s.userDataPath !== opts.userDataPath ||
        (s.book ?? null) !== (opts.book ?? null) ||
        Boolean(s.mirrorConsole) !== Boolean(opts.mirrorConsole))
    ) {
      // 非 HTTP 层错误不入错误码词表（http.ts 禁止自创同义码
      // 口径对齐）——统一 Error 形态 + logger.warn 留痕，reject 不再挂自创码
      const mismatch = new Error(
        `并发 start 参数与在途启动不一致（workDir=${JSON.stringify(opts.workDir)}），拒绝复用在途轮——请等在途 start 完成后再以新参数 start`,
      )
      cfg.logger.warn('server-manager', '并发 start 参数与在途启动不一致，已拒绝复用（fail-closed）', mismatch)
      return Promise.reject(mismatch)
    }
    return roundPromise(pending) // 并发 start 复用同一轮（bootstrap 重入防护之外的家底）
  }
  const round = openRound(ctx, opts)
  round.promise = (async () => {
    cancelPendingRestart(ctx) // 显式换轮作废挂起重启（与 stopChild 的取消面互补）
    // 重试/重启前清旧 child：等退出再 fork，避免端口/连接滞留（语义换轨）
    if (state.child) {
      cfg.logger.warn('server-manager', 'start 时旧 child 仍在——先停旧再 fork')
      await stopActiveChild(ctx)
    }
    // 主动 kill 标记的复位单点。旧实现此处是 `if (!shuttingDown)` 的
    // 条件复位，两条防线的等价性论证（的交织覆盖 + 入口守卫）写在注释里；
    // 现由状态机承担：stop='shutting' 时 'stop-clear' 在转移表里非法 → 拒绝并 error
    // 留痕（stop 保持 'shutting'，launch 的 fork 后检查照旧即杀新 child）。
    // 「shutdown 开始后绝不 fork 出存活 child」仍是任何交织下的硬约束。
    transition(ctx, { ev: 'stop-clear' })
    state.attempts = 0 // 显式 start 开新周期（bootstrap 语义，非崩溃续期）
    return await launch(ctx, round, '0')
  })()
  try {
    return await roundPromise(round)
  } finally {
    transition(ctx, { ev: 'round-close' }) // 轮收口（含在途 fork 句柄）同点归还
  }
}

/** 停机（幂等门 + 短预算等在途轮 + 优雅停机/强杀兜底；收口唤醒 restartPinned 等待者） */
async function shutdownServer(ctx: ManagerCtx): Promise<void> {
  const { cfg, state } = ctx
  // 幂等门改判停机流程门（引入的停机生命周期门）——此前用主动 kill
  // 标记：start 换旧 child 的 kill 等待窗（≈2s）内 stopActiveChild 置位标记，
  // before-quit 触发 shutdown 会误判「已在停机」直接返回，新 child 被 app 退出连带
  // 硬杀、在途编排收尾丢失。停机流程门只在本进程真正停机流程期间置位（stop='shutting'），
  // 是前文注释预告的「最后一个调用方向」，此处补上。
  if (isShutting(ctx)) return // 幂等：before-quit 可能多次触发
  // 停机流程门——入口置位 / finally 收口，期间 start 入口
  // fail-closed 拒绝（见 start 首守卫）。与主动 kill 标记分工：后者是「停旧不重启」
  // 标记（stopActiveChild 也置位），不随流程收口复位，不能当生命周期门用。
  // 三值合一：'shutting' 同时含标记语义——原 `shuttingDown = true` + try 内首行
  // `shutdownStarted = true`（先置位后下发：exit 早于 shutdown-done 到达也不误判
  // 崩溃）两点合并为一次转移，其间无读方。
  transition(ctx, { ev: 'shutdown-open' })
  try {
    // 在途 start/自动重启先落定——launch 的 fork 后检查（主动 kill
    // 标记已置位）会即杀新 child，此处等 handshake 收口拿到当值 child 走优雅停机链。
    // settleStarting 纳入短预算 race——裸 await 在握手挂起时最坏
    // 30s + kill 升级 2s×2 才落定（用户点退出最坏 ~41s 关不掉）。预算内收口（正常
    // 握手毫秒级）语义不变，后续优雅停机总窗仍由既有 race（shutdownTotalMs）兜底；
    // 超时即放弃等握手，下方对在途 fork 直接 kill 收口。settleStarting 内部 catch
    // 握手失败永不 reject，输掉的分支在后台自行落定、无未处理拒绝面。
    const settled = await Promise.race([
      settleStarting(ctx, 'shutdown').then(() => true),
      delay(cfg.shutdownSettleBudgetMs).then(() => false),
    ])
    cancelPendingRestart(ctx) // 退避等待期退出：挂起重启作废（不 fork 孤儿）
    const current = state.child
    if (!current) {
      if (!settled && state.round?.proc) {
        await killStartingProc(ctx, 'shutdown 在途 fork 收口')
      }
      return
    }
    current.proc.postMessage({ type: 'shutdown' })
    // 竞速三路：shutdown-done 回执 / 自然退出 / 总超时。回执后真实 child 立即
    // exit(0)，但 exit 事件与回执之间有异步缝——by 区分：回执到达再让渡一拍等
    // 自然退出（优雅路径不 kill）；超时（child 无响应）直接强杀。（对象属性承载
    // 状态：let 变量在闭包内改值会被 TS 流分析钉死在初值类型上）
    const settle: { by: 'done' | 'exit' | 'timeout' } = { by: 'timeout' }
    const done = new Promise<void>((resolveDone) => {
      // 协议面上 child→main 消息只有 ready/boot-error/shutdown-done 三种，前两者
      // 已随握手结束；on 不过滤移除——对象随退出消亡，无泄漏面
      current.proc.on('message', (message: unknown) => {
        if ((message as { type?: string })?.type === 'shutdown-done') {
          settle.by = 'done'
          resolveDone()
        }
      })
    })
    void current.exited.then(() => {
      settle.by = 'exit'
    })
    await Promise.race([done, current.exited, delay(cfg.shutdownTotalMs)])
    if (settle.by === 'done' && state.child?.proc === current.proc) {
      await Promise.race([current.exited, delay(cfg.killWaitMs)])
    }
    // 停机结果留痕（运维口径：批崩溃重启归因同样依赖 graceful/强杀区分）
    if (settle.by === 'done' || state.child?.proc !== current.proc) {
      cfg.logger.info(
        'server-manager',
        settle.by === 'done'
          ? 'studio server 子进程已停机（shutdown 指令链路）'
          : `studio server 子进程已停机（非 shutdown 回执路径：回执未达，收口时子进程已自行退出/被替换，settle=${settle.by}）`,
      )
    } else {
      cfg.logger.warn(
        'server-manager',
        settle.by === 'exit'
          ? 'shutdown 未回执但子进程已自行退出（协议未回执非超时态，下方 kill 为幂等兜底）'
          : 'shutdown 超时未回执，已强杀兜底',
      )
    }
    if (state.child?.proc === current.proc) {
      // 超时未退 / 回执后滞留：强杀兜底（总超时已覆盖 child 最坏预算，此处才是真强杀）
      current.proc.kill()
      // 同 stopChild——kill 后超时升级 SIGKILL，不再静默放行孤儿
      await killProcAwaitEscalating(current.proc, current.exited, 'shutdown', cfg.killWaitMs, cfg.logger)
    }
  } finally {
    // 停机流程门收口——允许下一轮 start（新生命周期；幂等 early-return
    // 的并发 shutdown 不经此处，由首调用方 finally 统一收口）。主动 kill 标记保留
    // （'marked'）：被杀 child 的迟到 exit 仍属预期。
    transition(ctx, { ev: 'shutdown-close' })
    // 唤醒停机收口等待者（restartPinned 自愈有界等待）
    const waiters = state.shutdownSettledWaiters
    state.shutdownSettledWaiters = []
    for (const w of waiters) w()
  }
}

/** 当值 child 读数（main 侧「关旧」判据之一） */
function isRunning(ctx: ManagerCtx): boolean {
  return ctx.state.child !== null
}

/** 挂起自动重启读数（child 已崩但重启在途时 isRunning 为 false，仅凭它会漏关） */
function hasPendingRestart(ctx: ManagerCtx): boolean {
  return ctx.state.backoffTimer !== null
}

/** 钉住端口自愈重启（session-end 观察窗：停机流程有界等待 + 在途轮复用 + 失败 resolve null） */
async function restartPinnedFromLastBoot(ctx: ManagerCtx): Promise<number | null> {
  const { cfg, state } = ctx
  const boot = state.lastBoot
  if (!boot) return null // 从未成功 start 过：无钉住面可复刻
  if (cfg.isProcessExiting()) {
    cfg.logger.warn('server-manager', 'session-end 自愈：本进程已进入退出链，放弃恢复')
    return null
  }
  if (isShutting(ctx)) {
    // 等待者闭包挂入 state.shutdownSettledWaiters，超时分支此前不摘除——超时
    // 返回后该 resolver 常驻数组直到下一次 shutdown（无界滞留）。用 finally 在
    // race 落定后从数组移除自身；停机收口路径已整体清空数组（indexOf=-1）为无害
    // no-op，落定语义不变。（对象属性承载 resolver：let 变量在闭包内赋值会被 TS
    // 流分析钉死在初值 null 上——同 shutdown settle 对象注释口径。）
    const waiterRef: { fn: (() => void) | null } = { fn: null }
    const settled = await Promise.race([
      new Promise<void>((resolve) => {
        waiterRef.fn = resolve
        state.shutdownSettledWaiters.push(resolve)
      }).then(() => true),
      delay(cfg.restartShutdownWaitMs).then(() => false),
    ]).finally(() => {
      const i = waiterRef.fn ? state.shutdownSettledWaiters.indexOf(waiterRef.fn) : -1
      if (i >= 0) state.shutdownSettledWaiters.splice(i, 1)
    })
    if (!settled) {
      cfg.logger.warn(
        'server-manager',
        `session-end 自愈：停机流程 ${cfg.restartShutdownWaitMs}ms 内未收口，放弃恢复（API 不可用，建议重启应用）`,
      )
      return null
    }
    if (isShutting(ctx) || cfg.isProcessExiting()) {
      // 收口瞬间已被新一轮停机（session-end 重臂 / before-quit）或退出链接管：
      // 本轮放弃——恢复面交给新的观察窗轮次，不在退出链上 fork 孤儿（/同向）
      cfg.logger.warn('server-manager', 'session-end 自愈：停机收口时本进程已再次进入停机/退出链，放弃恢复')
      return null
    }
  }
  // 在途轮复用（同款互斥通道语义）。2--①（
  // GLM-5.3）：原样透传在途轮会把在途 start 的 rejection 一起透传——逃逸
  // 本函数「失败 resolve null」契约（下方其余路径均 catch 返 null），调用方无
  // .catch 即落全局兜底日志。改对齐契约：复用值包一层 catch，失败留痕后
  // resolve null；成功值原样透传（复用语义不变）。
  const pending = state.round
  if (pending) {
    return roundPromise(pending).catch((e) => {
      cfg.logger.warn('server-manager', 'session-end 自愈恢复在途 start 失败（API 不可用，建议重启应用）', e)
      return null
    })
  }
  // 作废挂起重启，与 start 口径对称——不取消则崩溃退避
  // 挂起重启仍武装，开轮在途时 doRestart 触发会复刻钉住端口再 fork，双
  // child 竞逐当值位、输者成孤儿（起 cancelPendingRestart 收编 launchPinned
  // 首步，语义不变）。
  // 尾部「开轮 → 成功 info + onRestarted 隔离
  // → 失败留痕返 null → finally 收口」与 doRestart 同构，收敛 launchPinned；
  // 「显式新生命周期复位主动 kill 标记 + 退避计数清零（恢复不计入崩溃退避）」经
  // beforeLaunch 钩子保持原时序（开轮前）。红线：重启计数、钩子时序、
  // warn 文案逐位不变。
  return launchPinned(ctx, boot, {
    beforeLaunch: () => {
      // 显式新生命周期：复位主动 kill 标记 + 退避计数清零（与 start 轮内同口径，
      // 恢复不计入崩溃退避）——开轮前置位，防 fork 后检查即杀新 child
      transition(ctx, { ev: 'stop-clear' })
      state.attempts = 0
    },
    successLog: (got) =>
      cfg.logger.info('server-manager', `studio server 已恢复（session-end 观察窗自愈，端口 ${got} 钉住）`),
    failLog: (e) => cfg.logger.error('server-manager', 'session-end 自愈重启握手失败（API 不可用，建议重启应用）', e),
  })
}

/**
 * （评审）：管理器工厂——只剩组装与句柄映射；单元见
 * resolveManagerConfig（组装依赖）/ startServer（启动）/ scheduleRestart + nextBackoffMs
 * （重启退避）/ shutdownServer + stopActiveChild + killNow（停机）/ handshake + launch
 * （健康探测与接线）。相位/停机面的变更仍只经 transition（状态机语义不变）。
 */
export function createStudioServerManager(deps: ServerManagerDeps = {}): StudioServerManager {
  const ctx: ManagerCtx = { cfg: resolveManagerConfig(deps), state: createManagerState() }
  return {
    start: (opts) => startServer(ctx, opts),
    stopChild: () => stopChildImpl(ctx),
    killNow: () => killNow(ctx),
    shutdown: () => shutdownServer(ctx),
    isRunning: () => isRunning(ctx),
    restartPinned: () => restartPinnedFromLastBoot(ctx),
    hasPendingRestart: () => hasPendingRestart(ctx),
  }
}
