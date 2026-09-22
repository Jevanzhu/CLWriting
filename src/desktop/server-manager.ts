/**
 * main 侧 studio server 子进程管理器（阶段 22 批次 K）。
 *
 * 批 U1：fork server-utility 入口 + parentPort 握手（ready 端口回传 / boot-error
 * 信封）+ studioToken 首启生成/原子持久化（U-6 A）/启动读入内存一次、fork 一律复用
 * 内存值（二轮 F-5）+ stopChild（kill + 等退出）。
 * 批 U2：shutdown 指令下发 + shutdown-done 回执/3.5s 总超时强杀（E-1 覆盖 child 最坏预算）+ shutdownStarted
 * 状态门（S-5）+ stdio:pipe 日志单写者转发（§3.5：CLW_LOG_STDOUT=1 注入 + JSON 行
 * 解析按 level/tag/err 重发，err 透传 F-3，坏行原文兜底）。
 * 批 U3（本文件当前态）：崩溃退避自动重启——exit 非主动停机即排程重启（立即/5s/15s
 * 三档，3 次自动重启后再崩走 onRestartExhausted 封顶回调（main 接原生对话框）；
 * ready 后稳定 stabilityResetMs 计数清零（U-2/S-9——偶发单次崩溃不累计到 3 误弹）；
 * 重启钉住最近一次成功端口 + 同一内存 token（S-1：前端恢复链只认一次 boot 的同源
 * 端口，token 换代即永久 403）；重启期 EADDRINUSE 等握手失败按退避继续（§3.4 时序
 * 3）；重启全程占 starting 通道（X-3：握手在途窗口内并发 start 复用在途轮不双
 * fork）；shutdown/stopChild/start 三面取消挂起重启（S-5：退出途中 fork 新 child 成孤儿
 * 直接打挂验收门 4）。
 *
 * fork 以依赖注入暴露（测试换假件，不 mock electron 整模块）；入口路径按本模块
 * 产物位置派生（dist/desktop/server-utility.js，asar 内等价——R-6 同 server-main
 * dirname 派生先例）。env 显式展开 process.env + CLW_LOG_STDOUT=1（不污染 main 自身
 * process.env）。
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

// R0916-5g 拆分桥接：迁出公开导出逐名 re-export，全库 import 面零改动。
// 缝 1（desktop/server-proc.ts，进程管理族）：启动失败错误类 + 日志通道契约。
export { ServerBootError } from './server-proc.js'
export type { LogLike } from './server-proc.js'
// 缝 2（desktop/server-log.ts，服务端日志转发族）：stdio 单写者转发族。
export { MAX_LINE_CHARS, forwardLogLine, splitLines } from './server-log.js'

/** fork options 可辨识名：getAppMetrics 单列（ProcessMetric.name），S-12 */
export const STUDIO_SERVICE_NAME = 'studio-server'

/**
 * shutdown 总超时：不等 shutdown-done 回执的兜底（与拆分前 before-quit 2s 同量级，§3.4 时序 4）。
 * E-1（第五十三轮）：child 侧 graceful-shutdown 最坏预算 = close 1.5s + settle 1.5s 串行
 * ≈3s——原 2s 会在收尾窗口内强杀，打断 session/end 落库；提到 3.5s 覆盖 child 最坏
 * 预算（改动面最小、语义直白：main 兜底必须 ≥ child 自身兜底之和，否则兜底变打断）。
 * 测试经 shutdownTotalMs 注入缩短，不依赖本值保快。
 */
export const SHUTDOWN_TOTAL_TIMEOUT_MS = 3_500
/**
 * R44-12（四十四轮）：shutdown 等 settleStarting（在途 start/自动重启握手落定）的
 * 短预算——此前裸 await 无预算，握手挂起（child 模块加载卡死等）最坏
 * HANDSHAKE_TIMEOUT_MS(30s) + kill 升级 2s×2 才落定，用户点退出最坏 ~41s「关不掉」。
 * 预算内未收口 → 放弃等握手，对在途 fork 直接 kill 收口（握手期 server 未 ready、
 * 无在途编排可丢，硬杀无语义损失）；正常路径（握手毫秒级落定）语义不变。测试经
 * shutdownSettleBudgetMs 注入缩短，不依赖本值保快。
 */
const SHUTDOWN_SETTLE_BUDGET_MS = 2_000
/** 崩溃退避序列（第 1/2/3 次自动重启前的等待；U-2 建议立即/5s/15s） */
const RESTART_BACKOFF_MS: readonly number[] = [0, 5_000, 15_000]
/** 自动重启次数上限：第 3 次重启后的再崩溃不再自动重启，转 onRestartExhausted 决断 */
const RESTART_MAX_ATTEMPTS = 3
/** ready 后稳定窗口：child 存活过此窗口即清零重启计数（U-2/S-9 偶发单崩不累计） */
const STABILITY_RESET_MS = 5 * 60_000
/**
 * R55-A-1（五十五轮）：restartPinned 在 shuttingDown 态等停机收口的上限。session-end
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
  /** R44-12（四十四轮）：shutdown 等 settleStarting 的短预算（超时即放弃等握手、
   *  kill 在途 fork）；缺省 2s，测试注入缩短保快 */
  shutdownSettleBudgetMs?: number
  /** kill 后等退出的上限；测试注入缩短保快 */
  killWaitMs?: number
  /** 退避序列（第 1/2/3 次重启前等待）；缺省 [0, 5000, 15000]，测试注入缩短保快 */
  backoffMs?: readonly number[]
  /** ready 后稳定窗口，届时重启计数清零（U-2/S-9）；缺省 5 分钟 */
  stabilityResetMs?: number
  /** R55-A-1（五十五轮）：restartPinned 在 shuttingDown 态等停机收口的上限；
   *  缺省 RESTART_SHUTDOWN_WAIT_MS（5s），测试注入缩短保快 */
  restartShutdownWaitMs?: number
  /** R55-A-1（五十五轮）：本进程退出探测（main 注入 appTearingDown 读数）——自愈
   *  等待/收口窗口内用户真退出则放弃恢复（不在退出链上 fork 新 child 成孤儿，
   *  S-5/S1 同向）；缺省恒 false（无接线不放弃） */
  isProcessExiting?: () => boolean
  /**
   * 3 次自动重启耗尽后的用户决断（main 接原生对话框：重启服务/退出）：
   * 'restart' = 计数清零立即人工重启；'quit' = 不再重启（main 侧自行 app.quit）。
   * 缺省 'quit'——无接线不盲启（测试/降级态安全缺省）。
   */
  /** 封顶决断回调。R1010-P3（G7-②）：允许返回 Promise——main 侧对话框改异步
   *  showMessageBox（同步版泵原生嵌套消息循环，崩溃风暴路径上冻结三窗口输入/IPC）；
   *  决断到达前不重启不退出（本侧 void 适配，exit 回调不等它）。 */
  onRestartExhausted?: () => 'restart' | 'quit' | Promise<'restart' | 'quit'>
  /** 重审-3（2026-09-07 全量代码重审 §四.3）：自动重启（doRestart）/session-end
   *  自愈（restartPinned）钉住端口拉回成功后的广播钩子——main 接线后向存活渲染层
   *  广播 desktop:server-restarted（渲染层 sse.resync() 主动重连续用同源）。
   *  缺省无操作——无接线不广播（测试/降级态安全缺省）。 */
  onRestarted?: (port: number) => void
  /** 0918三拍板批（KEK v2）：OS 凭据通道 IKM 装置——缺省真件（safeStorage + 
   *  os-kek.json），测试注入假件（fixtures 无 vi.mock 纪律，同 fork 注入款）。 */
  loadOsKek?: (userDataPath: string) => Buffer | null
}

interface StartStudioServerOptions {
  /** null = welcome 态（fork 不带 --dir，S-8） */
  workDir: string | null
  /** Electron userData 目录（child 无 app 对象，经 --user-data 下发） */
  userDataPath: string
  /** --book 下沉的书名（main 侧已 resolveInitialBook，U-1 附带） */
  book?: string | null
  /** dev 态传 true → child 附 --mirror-console（打包态 false 不传） */
  mirrorConsole?: boolean
  /** 阶段 53 S2：应用版本号（main 侧 `app.getVersion()`；child 无 app 对象，经 env
   *  CLW_APP_VERSION 下发）。缺省不注入——dev/测试形态 child 回落读 package.json。 */
  appVersion?: string
}

interface ActiveChild {
  proc: UtilityProcessLike
  port: number
  /** ready 后注册：exit 事件 resolve（stopChild 等退出用；U3 重启也挂此处） */
  exited: Promise<void>
}

interface StudioServerManager {
  /** fork + 握手，resolve 实际监听端口（ready 消息回传）。旧 child 在途时先停旧再 fork；
   *  显式 start 开新生命周期（退避计数清零、挂起重启作废）。 */
  start(opts: StartStudioServerOptions): Promise<number>
  /** kill 当前 child 并等退出（bootstrap 重试清旧共用）；无 child 直通。主动停机：
   *  取消挂起重启 + S-5 门置位（随后的 exit 不触发自动重启）。 */
  stopChild(): Promise<void>
  /**
   * R0912-3（重评-0912 P3 #35）：崩溃退出兜底用——不等待收口，对在途 child/在途
   * fork 同步发出 kill 信号（fire-and-forget，无 SIGKILL 升级——升级等待属 stopChild
   * 链，调用方即退无窗口可等）。uncaughtException 的 200ms backstop 到点时 stopChild
   * 可能仍在 settle 竞速窗（预算 2s）内、kill 尚未发出，裸 process.exit 会把 child
   * 留成孤儿。置位主动停机门（被杀 child 的 exit 不触发自动重启）+ 作废挂起重启。
   */
  killNow(): void
  /**
   * 优雅停机（before-quit 收尾）：下发 shutdown 指令 → shutdownStudio 落定 →
   * shutdown-done 回执 / 总超时（3.5s，E-1）/ exit 三路先到为准；窗口内未退则 kill 兜底。
   * R44-12（四十四轮）：等在途启动（settleStarting）设短预算（缺省 2s），超时放弃等
   * 握手、直接 kill 在途 fork，不让用户点退出最坏挂 ~41s。
   * 幂等；与 stopChild 同属主动停机——均置 shutdownStarted（S-5，批 U3 重启门消费）。
   */
  shutdown(): Promise<void>
  /**
   * R50-A-1（五十轮）：session-end 观察窗自愈入口——win 上 OS 关机/注销被取消时
   * 进程仍存活，session-end 链已 shutdown 的 server 需显式拉回。复刻 doRestart 的
   * 钉住端口重启（S-1 前端恢复链同源：origin 不变，存活渲染层无缝续用），但作为
   * 显式新生命周期先复位「主动 kill 标记」shutdownStarted（与 start IIFE 首行同
   * 语义——那是防「停机途中崩溃自动重启复活」的挡板，不该挡显式恢复）。
   * R55-A-1（五十五轮）：停机流程仍在途不再立即返 null——有界等待停机收口后重试
   * 一次原路径（上限见 RESTART_SHUTDOWN_WAIT_MS / deps.restartShutdownWaitMs）；
   * 等待中或收口时本进程已入退出链（deps.isProcessExiting）或等待超时 → null，
   * 由调用方留痕。无历史 fork 面（从未 start 过）→ null。
   */
  restartPinned(): Promise<number | null>
  /** 是否有已握手完成的 child 在跑 */
  isRunning(): boolean
  /** 是否有崩溃退避后排程、尚未落地的挂起自动重启（P3：main 侧「关旧」判据补充——
   *  child 已崩但重启在途时 isRunning() 为 false，仅凭它会漏关并漏取消挂起重启） */
  hasPendingRestart(): boolean
}

/**
 * studioToken 首启生成 / 原子持久化 / 启动读入内存一次（U-6 A，S-2 + 二轮 F-5）：
 * - 跨崩溃重启（本进程内）与跨 main 重启（relaunch）token 均不变——前端全同源
 *   相对路径 + token 仅挂载时取一次（client.ts O-10），换代即写/SSE/心跳永久 403；
 * - 文件损坏/缺失 → 重生成覆写（窄边：仅影响下次启动，本次内存值继续用）；
 * - 安全口径不降级（ee-P2-12 拍板）：token 不承诺防本机进程，mode 0o600 防的
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

export function createStudioServerManager(deps: ServerManagerDeps = {}): StudioServerManager {
  const forkImpl = deps.fork ?? ((modulePath: string, args: string[], options: ForkOptionsLike) =>
    utilityProcess.fork(modulePath, args, options))
  const logger = deps.logger ?? log
  const shutdownTotalMs = deps.shutdownTotalMs ?? SHUTDOWN_TOTAL_TIMEOUT_MS
  // R44-12（四十四轮）：shutdown 等 settleStarting 的短预算（缺省见 SHUTDOWN_SETTLE_BUDGET_MS 头注）
  const shutdownSettleBudgetMs = deps.shutdownSettleBudgetMs ?? SHUTDOWN_SETTLE_BUDGET_MS
  const killWaitMs = deps.killWaitMs ?? KILL_WAIT_TIMEOUT_MS
  const backoffMs = deps.backoffMs ?? RESTART_BACKOFF_MS
  const stabilityResetMs = deps.stabilityResetMs ?? STABILITY_RESET_MS
  // R55-A-1（五十五轮）：自愈等停机收口上限 + 本进程退出探测（缺省见常量/依赖注释）
  const restartShutdownWaitMs = deps.restartShutdownWaitMs ?? RESTART_SHUTDOWN_WAIT_MS
  const isProcessExiting = deps.isProcessExiting ?? (() => false)
  // 重审-3（2026-09-07 全量代码重审 §四.3）：重启成功广播钩子（缺省无操作）
  const onRestarted = deps.onRestarted
  // 0918三拍板批（KEK v2）：OS 凭据通道 IKM 装置（缺省真件；不可用面在装置内回落 null）
  const loadOsKek = deps.loadOsKek ?? loadOrGenerateOsKek
  let active: ActiveChild | null = null
  let starting: Promise<number> | null = null
  // E-9a（第五十三轮）：在途 start 的关键 opts 快照——并发 start 复用同一轮前校验
  // 一致性，不一致 fail-closed 直接 reject（不静默吞没后到调用方的配置）
  let startingOpts: StartStudioServerOptions | null = null
  /** R44-12（四十四轮）：在途 start/自动重启的 fork 句柄——握手未完成时 active 尚空，
   *  shutdown 短预算耗尽后 kill 链靠它够得着这个 child（不登记则只能等 30s 握手
   *  超时或 app 退出连带硬杀）。随 starting 通道同置同清。 */
  let startingProc: UtilityProcessLike | null = null
  let tokenInMemory: string | null = null // F-5：启动读入一次，此后 fork 一律复用内存值
  // S-5 互斥门：主动停机（shutdown/stopChild）置位，child exit 属预期不触发重启；
  // start/shutdown/stopChild 均取消挂起重启——退出/换轮途中 fork 新 child 即孤儿。
  let shutdownStarted = false
  /** B-7（第六十轮）：停机流程生命周期门（shutdown 入口置位 / 收口复位）——与
   *  shutdownStarted（主动 kill 标记，stopActiveChild 也置位且不随收口复位）分工。 */
  let shuttingDown = false
  /** R55-A-1（五十五轮）：停机收口等待者——restartPinned 在 shuttingDown 态挂起等
   *  停机收口，shutdown finally 复位 shuttingDown 时一次性唤醒（事件驱动，不轮询；
   *  迟到的等待者由下一次收口唤醒，resolve 已落定 promise 为无害 no-op） */
  let shutdownSettledWaiters: Array<() => void> = []
  // 批 U3 退避状态：restartCount = 已排程的自动重启次数（ready 后稳定窗口到点清零）；
  // lastOpts/pinnedPort 供内部重启复刻原 fork 面（钉住最近一次成功端口，S-1）。
  let restartCount = 0
  let restartTimer: NodeJS.Timeout | null = null
  let lastOpts: StartStudioServerOptions | null = null
  let pinnedPort: number | null = null

  function cancelPendingRestart(): void {
    if (restartTimer) {
      clearTimeout(restartTimer)
      restartTimer = null
    }
  }

  /**
   * R0912-A-P3-2（2026-09-12 独立重评修复批）：预算耗尽时对在途 fork 的就地 kill 收口
   * （stopChild / shutdown 两段逐字同构块收拢为局部闭包，行为零变化）——句柄快照 +
   * once('exit') 等待 + kill + killProcAwaitEscalating 纪律（killWaitMs 等待 + SIGKILL
   * 升级）。无在途 fork（startingProc 已清）直通；`!settled && startingProc` 守卫留在
   * 调用点（settled 属各自 race 局部量）。
   */
  async function killStartingProc(context: string): Promise<void> {
    const proc = startingProc
    if (!proc) return
    const exited = new Promise<void>((resolveExit) => {
      proc.once('exit', () => resolveExit())
    })
    proc.kill()
    await killProcAwaitEscalating(proc, exited, context, killWaitMs, logger)
  }

  /**
   * fork + 握手 + 接线（start 与内部重启共用）。
   * portArg：start 传 '0'（OS 分配）；重启传钉住端口字符串（S-1 前端恢复链同源）。
   * 成功后登记 active/lastOpts/pinnedPort、挂持久 exit 监听（非主动停机 → 排程重启）、
   * 起稳定窗口计时（S-9：本轮 child 存活过窗口才清零——回调时校验 active 身份，
   * 迟到的旧 child exit 不会误清新一轮计数）。
   */
  async function launch(opts: StartStudioServerOptions, portArg: string): Promise<number> {
    if (tokenInMemory === null) tokenInMemory = loadOrCreateStudioToken(opts.userDataPath)
    // E-9b（第五十三轮）：token 不经 argv（本机 ps 可见）——改经 env CLW_STUDIO_TOKEN
    // 注入（server-boot parseServerArgs 读取侧同步切 env），argv 面不再出现 token。
    const args: string[] = ['--user-data', opts.userDataPath, '--port', portArg]
    if (opts.workDir) args.push('--dir', opts.workDir)
    if (opts.book) args.push('--book', opts.book)
    if (opts.mirrorConsole) args.push('--mirror-console')
    // stdio:pipe + CLW_LOG_STDOUT=1（§3.5 单写者）：child 日志只走 stdout JSON 行，
    // 由 main 收行重发落盘；env 展开拷贝，不污染 main 自身 process.env
    // N-1（第五十四轮）：宿主 process.env 残留的 CLW_STUDIO_TOKEN 先在拷贝上显式
    // delete 再注入受控值——不依赖对象字面量后键覆盖的隐式顺序，防旧值穿透（仅动
    // 拷贝，process.env 本身不动）
    const childEnv: Record<string, string | undefined> = { ...process.env }
    // R1W-6（win 平台专项复审 R1）：win 环境变量名不区分大小写、保序保留——裸 delete
    // 认不到宿主残留的小写/混写变体（clw_studio_token），子进程 env block 会出现
    // 双重键、取值未指定（命中旧值 = 全请求 403）。逐键大小写不敏感清除后再注入。
    // R41-7（四十一轮）：清除面补 CLW_LOG_STDOUT——下方注入 CLW_LOG_STDOUT=1，若宿主
    // 残留混写变体（clw_log_stdout）同样双键穿透，child 日志形态被旧值劫持。
    // R43-26（四十三轮）：清除面再补 CLW_DEV_UI / CLW_DEV_CORS / CLWRITING_RESOURCES_DIR
    // ——防宿主残留泄漏进打包 child：前两者会让 child 的 Origin 白名单放宽放行 5173
    // （server/index.ts dev 注入面，本应只属于 scripts/dev-api.ts 的独立进程）；后者
    // 会把 child 捆绑资源根钉到宿主目录（fs/resources.ts 无 electron 依赖、打包态检查
    // 不可达，fork 前剥除 = child 回落模块相对推导 asar 内资源）。合法 dev 链路不经本
    // manager 携带这些变量（devUi 态 main 不 fork server；dev:api 是独立进程自带 env），
    // 剥除无旁损。
    // 0918三拍板批（KEK v2）：清除面再补 CLW_OS_KEK——宿主残留会绕过下方受控注入
    //（旧 IKM 穿透 = v2 vault 解锁失败或错通道），同款逐键清洗后注入。
    // 阶段 53 S2：清除面再补 CLW_APP_VERSION——宿主残留版本号会让更新检查比错基准
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
    childEnv['CLW_STUDIO_TOKEN'] = tokenInMemory
    childEnv['CLW_LOG_STDOUT'] = '1'
    // 阶段 53 S2：版本号经 env 下发（缺省不注入——child 回落读 package.json）
    if (opts.appVersion) childEnv['CLW_APP_VERSION'] = opts.appVersion
    // 0918三拍板批（KEK v2）：OS 通道 IKM 经 env 注入（safeStorage 只在主进程可用，
    // 子进程按 hex 接收；null = 无 OS 通道，子进程回落 v1 内置通道语义）
    const osKek = loadOsKek(opts.userDataPath)
    if (osKek) childEnv['CLW_OS_KEK'] = osKek.toString('hex')
    const proc = forkImpl(entryModulePath(), args, {
      serviceName: STUDIO_SERVICE_NAME,
      stdio: 'pipe',
      env: childEnv,
    })
    // S1（五十九轮）：fork 后发现停机已置位 → 立即杀掉新 child 并按启动失败收口。
    // 在途 start/自动重启（X-3 starting 通道）的握手窗口内 shutdown/stopChild 落地时，
    // shutdown 侧 settleStarting 只能等到 handshake 完成——fork 即杀把窗口收窄到
    // 「已 fork 未检查」的同步缝隙，新 child 不再漏杀成孤儿（优雅停机面收口）。
    // R0912-3（重评-0912 P3 #34）：kill 收编 killProcAwaitEscalating 同款等待/升级
    // 纪律（TERM→等 killWaitMs→SIGKILL，握手超时/boot-error 分支同款）——此前
    // fire-and-forget，SIGTERM 被吞（child 卡死在不可中断调用）时新 child 在停机链上
    // 漏杀成孤儿。与既有 stop 路径的差异点：收口形态仍是启动失败——等杀链走完再抛
    // ServerBootError('SHUTDOWN')（握手超时分支同款时序），settleStarting 侧经
    // settle/catch 照常落定，启动期其余语义不变。
    if (shutdownStarted) {
      const exited = new Promise<void>((resolveExit) => {
        proc.once('exit', () => resolveExit())
      })
      proc.kill()
      await killProcAwaitEscalating(proc, exited, 'studio server 停机期在途 fork 收口', killWaitMs, logger)
      throw new ServerBootError('SHUTDOWN', 'studio server 启动途中收到停机指令，已中止新 child')
    }
    // R44-12（四十四轮）：在途 fork 句柄登记（与 starting 通道同生命周期，start/
    // doRestart 的 finally 同步清空）——shutdown 短预算耗尽时 kill 链经此够到它
    startingProc = proc
    forwardChildStdio(proc, logger) // 握手前接线——boot 期日志不丢
    // R0911-A-P3-2（2026-09-11 全量重评 GLM-5.3 修复批）：utilityProcess 'error' 必监听
    // ——V8 FatalError/OOM/spawn 失败等异常终止经该事件抛诊断，EventEmitter 语义下无监听
    // 即 uncaughtException 崩主进程；此前既不监听也不留痕，child 静默消失只剩 restart 链
    // 兜底重启，根因（V8 级崩溃原因）永久丢失。持久监听随 child 消亡，诊断进档；握手期
    // 的 'error' 另由 handshake() 的监听快失败（不必等满 30s 超时），两监听并存不冲突
    //（handshake settle 有 settled 单飞闸，本监听只记日志不参与结算）。
    proc.on('error', (type: string, location: string, report: string) => {
      logger.error(
        'server-manager',
        `studio server utilityProcess 异常终止（error 事件：${type}${location ? ` @ ${location}` : ''}）`,
        report,
      )
    })
    const port = await handshake(proc, logger, killWaitMs)
    // 稳定窗口计时（unref 不拖退出）：到点仍是他为 active 才清零
    const stabilityTimer = setTimeout(() => {
      if (active?.proc === proc) restartCount = 0
    }, stabilityResetMs)
    stabilityTimer.unref()
    const exited = new Promise<void>((resolveExit) => {
      proc.once('exit', () => {
        clearTimeout(stabilityTimer)
        const wasActive = active?.proc === proc
        if (wasActive) active = null
        resolveExit()
        // S-5：非主动停机且确系当值 child 崩溃 → 排程重启（迟到旧 exit 不触发）
        if (wasActive && !shutdownStarted) scheduleRestart()
      })
    })
    active = { proc, port, exited }
    lastOpts = opts
    pinnedPort = port
    return port
  }

  function scheduleRestart(): void {
    if (shutdownStarted || restartTimer) return // 主动停机不重启 / 已有挂起重启不双排
    if (restartCount >= RESTART_MAX_ATTEMPTS) {
      logger.error('server-manager', `studio server 连续崩溃：${RESTART_MAX_ATTEMPTS} 次自动重启后仍异常，转用户决断`)
      // R1010-P3（G7-②）：决断可能异步（异步对话框）——exit 回调不等它，决断到达
      // 前不重启不退出；期间 active 已空、无新 exit 事件，无重入面
      // R0912-A-P3-4（2026-09-12 独立重评修复批）：决断链补 .catch——异步决断 reject
      // （对话框链异常等）此前无接手即成 unhandledRejection；catch 记错误日志后走兜底
      // 'quit' 语义（本模块的 quit 缺省 = 不再自动重启，真退出由 main 侧执行，deps 无
      // quit 钩子可调——保持进程现状不重启即该语义的兜底形态）。
      // R0917-6-nano（2026-09-17 全库源码重评六轮修复批）：缺省 'quit' 臂补显式 error
      // 留痕——本模块 deps 无 quit 钩子可调（真退出由 main 侧执行），「quit 语义」的实际
      // 形态 = 保持进程现状、不再自动重启；生产 main.ts 已接线 onRestartExhausted，此臂
      // 只在接线缺失/异常时到场，届时进程停在「无 server、无提示」态。此前该降级态只由
      // 上面那条「连续崩溃 3 次」日志间接指示，作者无从区分「正在重启」与「已放弃」。
      // 现两条路径（无钩子 / 决断为 quit）各补一条终态 error，与决策表口径「API 永久不可用」
      // 显式对齐（评审 P3-9 的取法：语义不变，只让降级态可感知）。
      const quitFallback = (why: string): void => {
        logger.error(
          'server-manager',
          `studio server 已放弃自动重启（${why}）：进程保持运行但本地 API 永久不可用，请重启应用。`,
        )
      }
      if (!deps.onRestartExhausted) {
        quitFallback('无崩溃封顶决断钩子')
        return
      }
      void Promise.resolve(deps.onRestartExhausted())
        .then((choice) => {
          if (choice === 'restart') {
            restartCount = 0 // 人工重启计一次全新周期
            scheduleRestart()
            return
          }
          quitFallback('作者决断 quit')
        })
        .catch((e) => {
          logger.error('server-manager', '崩溃封顶决断回调失败，按兜底 quit 语义收口（不再自动重启）', e)
          quitFallback('决断回调异常')
        })
      return
    }
    restartCount++
    const waitMs = backoffMs[Math.min(restartCount - 1, backoffMs.length - 1)] ?? 0
    logger.warn('server-manager', `studio server 子进程异常退出，${waitMs}ms 后自动重启（第 ${restartCount}/${RESTART_MAX_ATTEMPTS} 次）`)
    restartTimer = setTimeout(() => {
      restartTimer = null
      void doRestart()
    }, waitMs)
    restartTimer.unref()
  }

  /**
   * F3（复审-0914-优化修复批）：doRestart / restartPinned 的同构核心收敛——
   * cancelPendingRestart →（调用方旗复位钩子）→ starting 通道占位 launch（钉住端口）
   * → 成功 info + onRestarted 广播隔离 try/catch（重审-3：钩子抛错不得伪装成握手失败）
   * → 失败 failLog → finally 清理通道/句柄。握手失败返回 null（调用方各自处置：
   * doRestart 按退避续排 / restartPinned 契约返 null）。
   * 红线核对：重启计数（本函数不触碰 restartCount——restartPinned 的清零经 beforeLaunch
   * 钩子保持在原 launch 占位前的时序点）、钩子时序、warn 文案逐位不变。doRestart 侧
   * 新增的 cancelPendingRestart 在原调用形态下恒 no-op（restartTimer 触发回调已先置
   * null），与 restartPinned 原显式取消（R51-A-3）合一后语义不变。
   */
  async function launchPinned(
    opts: StartStudioServerOptions,
    port: number,
    hooks: {
      /** launch 占位前调用（restartPinned 的 shutdownStarted/restartCount 复位原序保留） */
      beforeLaunch?: () => void
      successLog: (port: number) => void
      failLog: (e: unknown) => void
    },
  ): Promise<number | null> {
    cancelPendingRestart()
    hooks.beforeLaunch?.()
    // X-3（第五十六轮）：重启全程复用 starting 互斥通道——占位后并发 start 同参数复用
    // 在途重启轮（含钉住端口语义）、参数不一致沿用 E-9a fail-closed reject；finally
    // 清空归还通道。
    startingOpts = opts
    starting = (async () => launch(opts, String(port)))()
    try {
      const got = await starting
      hooks.successLog(got)
      // 重审-3：广播钩子隔离——钩子抛错不得伪装成「握手失败」再排一轮重启（服务实际已在跑）
      try {
        onRestarted?.(got)
      } catch (e) {
        logger.warn('server-manager', 'onRestarted 广播钩子抛错（已忽略）', e)
      }
      return got
    } catch (e) {
      hooks.failLog(e)
      return null
    } finally {
      starting = null
      startingOpts = null
      startingProc = null // R44-12：与 starting 通道同清
    }
  }

  async function doRestart(): Promise<void> {
    if (shutdownStarted) return // 等待窗口内被停机（S-5）
    // R1010b-DSK-P3-2（2026-09-10 内存专项重审修复批）：在途不覆写——R51-A-3 注释自认
    // 「doRestart 不查 starting 直接覆写通道」：崩溃风暴对话框等待期（onRestartExhausted
    // 异步决断在途，R1010-P3 G7-② 起）并发 restartPinned 自愈握手在途时，0ms 退避触发的
    // doRestart 会覆写 starting/startingOpts/startingProc——先落定方的 finally 清错通道
    // 与 fork 句柄、launch 双 fork 竞逐 active（输者孤儿）。对齐 start() 复用口径：通道
    // 被占即复用在途轮（其自身 catch 已按退避续排 / 留痕），本函数不再排新轮。
    if (starting) {
      await starting.catch(() => {}) // 在途轮落定即本函数语义完成，失败已由在途轮自身路径收口
      return
    }
    const opts = lastOpts
    const port = pinnedPort
    if (!opts || port === null) return
    await launchPinned(opts, port, {
      successLog: (got) => logger.info('server-manager', `studio server 已自动重启（端口 ${got} 钉住）`),
      failLog: (e) => {
        // 重启期握手失败（EXIT/EADDRINUSE 残留端口等）按退避继续（§3.4 时序 3）
        logger.error('server-manager', '自动重启握手失败，按退避序列继续', e)
        scheduleRestart()
      },
    })
  }

  /**
   * S1（五十九轮）：等在途 start/自动重启（X-3 starting 通道）落定再判 active。
   * 握手窗口内 active===null，shutdown/stopChild 只看 active 会让刚 fork 的 child
   * 收不到停机指令只能硬杀（在途编排 abort + session/end 落库丢失）。握手失败
   * （boot-error/EXIT）catch 吞掉——那是启动失败路径，继续停机面即可。
   */
  async function settleStarting(source: string): Promise<void> {
    const pending = starting
    if (!pending) return
    try {
      await pending
    } catch (e) {
      logger.warn('server-manager', `${source}：在途启动握手失败（已忽略，继续停机）`, e)
    }
  }

  /**
   * R26-87（二十六轮）：kill 后等退出，超时不再静默放行——升级 SIGKILL 强杀。
   * 依据（electron.d.ts 实证）：utilityProcess 的 kill() 无信号参数（`kill(): boolean`，
   * POSIX 走 SIGTERM），而 UtilityProcess.pid 可得（spawn 前/exit 后为 undefined）——
   * SIGTERM 被吞（child 卡死在不可中断调用）时原「超时放行」会把 child 永久留成孤儿，
   * pid 在手即可 process.kill(pid, 'SIGKILL')（Windows 上 Node 将 SIGKILL 映射为进程
   * 终止，跨平台成立）。kill 竞态窗口内 child 已自行退出（ESRCH）等失败只留痕不阻断
   * 停机链；升级后再等一轮 killWaitMs（超时放行口径保留为最终兜底）。
   */
  async function killAwaitEscalating(current: ActiveChild, context: string): Promise<void> {
    // R27-90（二十七轮）：主体抽到模块级 killProcAwaitEscalating——握手超时路径（模块级
    // handshake 够不着工厂闭包）也要用同一套 kill+等退出+升级纪律，不再各写一份。
    return killProcAwaitEscalating(current.proc, current.exited, context, killWaitMs, logger)
  }

  /** stopChild 核心（kill + 等退出）；start 的换轮路径直接用（此时 starting 是 start
   *  自身 IIFE 的 promise——公共 stopChild 的 settleStarting 会 await 自己死锁）。 */
  async function stopActiveChild(): Promise<void> {
    const current = active
    cancelPendingRestart()
    if (!current) return
    shutdownStarted = true // 主动 kill：随后的 exit 是预期收口，不触发重启（S-5）
    current.proc.kill()
    // SIGTERM 被吞的兜底：R26-87 起超时升级 SIGKILL 强杀（退出事件迟到时 active 已由
    // exit 监听清空，语义不变）；无 pid / 升级失败回落「超时放行」
    await killAwaitEscalating(current, 'stopChild')
  }

  /**
   * R0912-3（重评-0912 P3 #35）：killNow 的实现——同步对在途 fork/当值 child 发 kill
   * 信号后立即返回（不等待退出、无升级）。握手已落定而 starting 通道未清的窄窗内
   * startingProc 与 active.proc 同指一个 child，双 kill 对已死句柄为无害幂等。
   */
  function killNow(): void {
    cancelPendingRestart()
    shutdownStarted = true // S-5：被杀 child 的 exit 不触发自动重启
    startingProc?.kill()
    active?.proc.kill()
  }

  return {
    async start(opts: StartStudioServerOptions): Promise<number> {
      // B-7（第六十轮）：停机流程进行中 start fail-closed 拒绝——S1 的注释与复位只覆盖
      // 「shutdown 先于 start 开始」的正向时序；反向时序（shutdown 已置位并停驻 kill/exit
      // 等待点，此时 starting===null）下 start 进入会在 IIFE 首行同步清掉 shutdownStarted，
      // launch 的 fork 后检查失守 → 新 child 在停机流程中途存活。现状唯一调用链
      // bootstrapRunner 有 shuttingDown 守卫挡住、不可达——本修复把「靠调用纪律」变成
      // 机制（与 E-9a 参数不一致拒绝同口径）。注意用独立的 shuttingDown 生命周期门：
      // shutdownStarted 还承载「主动 kill 标记」语义（stopActiveChild 置位防 exit 触发
      // 重启），stopChild 之后的 start 换轮必须放行，不能一并拒绝。
      if (shuttingDown) {
        const err = new Error('停机流程进行中，拒绝 start（shutdown 已置位）——请等待停机完成')
        logger.warn('server-manager', '停机中收到 start，fail-closed 拒绝', err)
        return Promise.reject(err)
      }
      if (starting) {
        // E-9a（第五十三轮）：并发 start 复用同一轮前校验关键 opts 一致（dir/user-data/
        // book/mirror-console）——不一致 fail-closed reject，不静默拿前者配置吞没后到调用方
        const s = startingOpts
        if (
          s &&
          (s.workDir !== opts.workDir ||
            s.userDataPath !== opts.userDataPath ||
            (s.book ?? null) !== (opts.book ?? null) ||
            Boolean(s.mirrorConsole) !== Boolean(opts.mirrorConsole))
        ) {
          // N-9（第五十四轮）：非 HTTP 层错误不入错误码词表（http.ts 禁止自创同义码
          // 口径对齐）——统一 Error 形态 + logger.warn 留痕，reject 不再挂自创码
          const mismatch = new Error(
            `并发 start 参数与在途启动不一致（workDir=${JSON.stringify(opts.workDir)}），拒绝复用在途轮——请等在途 start 完成后再以新参数 start`,
          )
          logger.warn('server-manager', '并发 start 参数与在途启动不一致，已拒绝复用（fail-closed）', mismatch)
          return Promise.reject(mismatch)
        }
        return starting // 并发 start 复用同一轮（bootstrap 重入防护之外的家底）
      }
      startingOpts = opts
      starting = (async () => {
        cancelPendingRestart() // 显式换轮作废挂起重启（与 stopChild 的取消面互补）
        // 重试/重启前清旧 child：等退出再 fork，避免端口/连接滞留（L-3 语义换轨，S-4）
        if (active) {
          logger.warn('server-manager', 'start 时旧 child 仍在——先停旧再 fork')
          await stopActiveChild()
        }
        // 停机门复位单点（复审-0914-优化修复批 P3：原 IIFE 首行无条件复位〔S1〕+
        // 此处条件式复位〔重评-P3-8〕两点合一，明显冗余复位合并；三旗状态机不动）。
        // 合并的时序安全性论证（两处原防线的等价覆盖面）：
        // ① S1 防的「shutdown 恰落在 stopActiveChild 的 await 等待窗内、无条件复位把
        //    门静默清掉（launch fork 后检查失守）」——条件式已覆盖：该交织下并发
        //    shutdown() 同步置 shuttingDown + shutdownStarted，本行 `!shuttingDown`
        //    判假保持门置位 → launch 的 fork 后检查即杀新 child 按启动失败收口
        //    （「shutdown 开始后绝不 fork 出存活 child」在任何交织下成立）。
        // ② S1 注的反向时序（shutdown 已置位停驻 kill/exit 等待点、starting===null 时
        //    start 进入门被首行复位清掉）——B-7 入口 fail-closed 守卫已挡（shutdown
        //    流程在途 ⇔ shuttingDown 已置位〔同步序〕，start 根本进不来）。
        // ③ 占通道到本行之间无 shutdownStarted 读方（stopActiveChild 只置位不读；
        //    并发 restartPinned/doRestart 走 starting 通道复用、shutdown 走 shuttingDown
        //    门），复位时点从 IIFE 首行推迟到 launch 前一行无任何可观察差。
        if (!shuttingDown) shutdownStarted = false
        restartCount = 0 // 显式 start 开新周期（bootstrap 语义，非崩溃续期）
        return await launch(opts, '0')
      })()
      try {
        return await starting
      } finally {
        starting = null
        startingOpts = null
        startingProc = null // R44-12：与 starting 通道同清
      }
    },
    async stopChild(): Promise<void> {
      // R49-4（评审四十九轮）：主动停机门先置位（同 shutdown 入口形态）——在途 fork
      // 若恰在预算窗内完成握手后被就地 kill，其 exit 不会误触自动重启（doRestart
      // catch 的 scheduleRestart 与 launch 的 exit 监听都消费此门）。幂等：stopActiveChild
      // 的置位与 start IIFE 首行的复位语义不受影响（stopChild 后的 start 换轮照常放行）。
      shutdownStarted = true
      // S1（五十九轮）：在途 start/自动重启先落定（catch 握手失败）再判 active——
      // 握手窗口内 active===null，只看 active 会让刚 fork 的 child 漏杀成孤儿。
      // R49-4（评审四十九轮）：settleStarting 纳入短预算 race，与 shutdown 的 R44-12
      // 形态对齐——此前裸 await 在握手挂起时最坏 HANDSHAKE_TIMEOUT_MS(30s) + kill
      // 升级 2s×2 才落定（崩溃重启链上的 bootstrap 重试最坏阻塞用户 ~34s 无响应）。
      // 预算内收口（正常握手毫秒级）语义不变；超时即放弃等握手，下方对在途 fork
      // 直接 kill 收口。settleStarting 内部 catch 握手失败永不 reject，输掉的分支在
      // 后台自行落定、无未处理拒绝面。
      const settled = await Promise.race([
        settleStarting('stopChild').then(() => true),
        delay(shutdownSettleBudgetMs).then(() => false),
      ])
      // R49-4（评审四十九轮）：预算耗尽且握手未收口——在途 fork 不再等 30s 握手超时，
      // 就地 kill + 等退出收口（killProcAwaitEscalating 纪律原样复用：killWaitMs 等待
      // + SIGKILL 升级，本段不新增等待语义）。settled=true 的空 active 属握手已失败/
      // child 已退形态，其自身路径已收口，此处无需动作。
      // R0912-A-P3-2：同构块收拢为 killStartingProc（行为零变化）。
      if (!settled && startingProc) {
        await killStartingProc('stopChild 在途 fork 收口')
      }
      await stopActiveChild()
    },
    killNow,
    async shutdown(): Promise<void> {
      // R62-16：幂等门改判 shuttingDown（B-7 引入的停机生命周期门）——此前用
      // shutdownStarted：start 换旧 child 的 kill 等待窗（≈2s）内 stopActiveChild 置位
      // shutdownStarted，before-quit 触发 shutdown 会误判「已在停机」直接返回，新 child 被
      // app 退出连带硬杀、在途编排收尾丢失。shuttingDown 只在本进程真正停机流程期间置位，
      // 是前文 B-7 注释预告的「最后一个调用方向」，此处补上。
      if (shuttingDown) return // 幂等：before-quit 可能多次触发
      // B-7（第六十轮）：停机流程生命周期门——入口置位 / finally 复位，期间 start 入口
      // fail-closed 拒绝（见 start 首守卫）。与 shutdownStarted 分工：后者是「主动 kill
      // 标记」（stopActiveChild 也置位），不随 shutdown 收口复位，不能当生命周期门用。
      shuttingDown = true
      try {
        shutdownStarted = true // 先置位后下发：exit 早于 shutdown-done 到达也不误判崩溃（S-5）
        // S1（五十九轮）：在途 start/自动重启先落定——launch 的 fork 后检查（shutdownStarted
        // 已置位）会即杀新 child，此处等 handshake 收口拿到 active 走优雅停机链。
        // R44-12（四十四轮）：settleStarting 纳入短预算 race——裸 await 在握手挂起时最坏
        // 30s + kill 升级 2s×2 才落定（用户点退出最坏 ~41s 关不掉）。预算内收口（正常
        // 握手毫秒级）语义不变，后续优雅停机总窗仍由既有 race（shutdownTotalMs）兜底；
        // 超时即放弃等握手，下方对在途 fork 直接 kill 收口。settleStarting 内部 catch
        // 握手失败永不 reject，输掉的分支在后台自行落定、无未处理拒绝面。
        const settled = await Promise.race([
          settleStarting('shutdown').then(() => true),
          delay(shutdownSettleBudgetMs).then(() => false),
        ])
        cancelPendingRestart() // 退避等待期退出：挂起重启作废（不 fork 孤儿）
        const current = active
        if (!current) {
          if (!settled && startingProc) {
            await killStartingProc('shutdown 在途 fork 收口')
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
        await Promise.race([done, current.exited, delay(shutdownTotalMs)])
        if (settle.by === 'done' && active?.proc === current.proc) {
          await Promise.race([current.exited, delay(killWaitMs)])
        }
        // 停机结果留痕（运维口径：批 U3 崩溃重启归因同样依赖 graceful/强杀区分）
        if (settle.by === 'done' || active?.proc !== current.proc) {
          logger.info(
            'server-manager',
            settle.by === 'done'
              ? 'studio server 子进程已停机（shutdown 指令链路）'
              : `studio server 子进程已停机（非 shutdown 回执路径：回执未达，收口时子进程已自行退出/被替换，settle=${settle.by}）`,
          )
        } else {
          logger.warn(
            'server-manager',
            settle.by === 'exit'
              ? 'shutdown 未回执但子进程已自行退出（协议未回执非超时态，下方 kill 为幂等兜底）'
              : 'shutdown 超时未回执，已强杀兜底',
          )
        }
        if (active?.proc === current.proc) {
          // 超时未退 / 回执后滞留：强杀兜底（E-1：总超时已覆盖 child 最坏预算，此处才是真强杀）
          current.proc.kill()
          // R26-87：同 stopChild——kill 后超时升级 SIGKILL，不再静默放行孤儿
          await killAwaitEscalating(current, 'shutdown')
        }
      } finally {
        // B-7：停机生命周期门复位——收口后允许下一轮 start（新生命周期；幂等 early-return
        // 的并发 shutdown 不经此处，由首调用方 finally 统一复位）
        shuttingDown = false
        // R55-A-1（五十五轮）：唤醒停机收口等待者（restartPinned 自愈有界等待）
        const waiters = shutdownSettledWaiters
        shutdownSettledWaiters = []
        for (const w of waiters) w()
      }
    },
    isRunning(): boolean {
      return active !== null
    },
    async restartPinned(): Promise<number | null> {
      const opts = lastOpts
      const port = pinnedPort
      if (!opts || port === null) return null // 从未成功 start 过：无钉住面可复刻
      if (isProcessExiting()) {
        logger.warn('server-manager', 'session-end 自愈：本进程已进入退出链，放弃恢复')
        return null
      }
      if (shuttingDown) {
        // R0910-W：等待者闭包挂入 shutdownSettledWaiters，超时分支此前不摘除——超时
        // 返回后该 resolver 常驻数组直到下一次 shutdown（无界滞留）。用 finally 在
        // race 落定后从数组移除自身；停机收口路径已整体清空数组（indexOf=-1）为无害
        // no-op，落定语义不变。（对象属性承载 resolver：let 变量在闭包内赋值会被 TS
        // 流分析钉死在初值 null 上——同 shutdown() settle 对象注释口径。）
        const waiterRef: { fn: (() => void) | null } = { fn: null }
        const settled = await Promise.race([
          new Promise<void>((resolve) => {
            waiterRef.fn = resolve
            shutdownSettledWaiters.push(resolve)
          }).then(() => true),
          delay(restartShutdownWaitMs).then(() => false),
        ]).finally(() => {
          const i = waiterRef.fn ? shutdownSettledWaiters.indexOf(waiterRef.fn) : -1
          if (i >= 0) shutdownSettledWaiters.splice(i, 1)
        })
        if (!settled) {
          logger.warn(
            'server-manager',
            `session-end 自愈：停机流程 ${restartShutdownWaitMs}ms 内未收口，放弃恢复（API 不可用，建议重启应用）`,
          )
          return null
        }
        if (shuttingDown || isProcessExiting()) {
          // 收口瞬间已被新一轮停机（session-end 重臂 / before-quit）或退出链接管：
          // 本轮放弃——恢复面交给新的观察窗轮次，不在退出链上 fork 孤儿（S-5/S1 同向）
          logger.warn('server-manager', 'session-end 自愈：停机收口时本进程已再次进入停机/退出链，放弃恢复')
          return null
        }
      }
      // 在途轮复用（X-3 同款互斥通道语义）。重评2-P3-①（2026-09-09 全量重评
      // GLM-5.3）：原样透传 starting 会把在途 start 的 rejection 一起透传——逃逸
      // 本函数「失败 resolve null」契约（下方其余路径均 catch 返 null），调用方无
      // .catch 即落全局兜底日志。改对齐契约：复用值包一层 catch，失败留痕后
      // resolve null；成功值原样透传（复用语义不变）。
      if (starting) {
        return starting.catch((e) => {
          logger.warn('server-manager', 'session-end 自愈恢复在途 start 失败（API 不可用，建议重启应用）', e)
          return null
        })
      }
      // R51-A-3（五十一轮）：作废挂起重启，与 start() 口径对称——不取消则崩溃退避
      // restartTimer 仍武装，launch 在途时 doRestart 触发会复刻钉住端口再 fork，双
      // child 竞逐 active、输者成孤儿（F3 起 cancelPendingRestart 收编 launchPinned
      // 首步，语义不变）。
      // F3（复审-0914-优化修复批）：尾部「占位 launch → 成功 info + onRestarted 隔离
      // → 失败留痕返 null → finally 清理」与 doRestart 同构，收敛 launchPinned；
      // 「显式新生命周期复位主动 kill 标记 + 退避计数清零（恢复不计入崩溃退避）」经
      // beforeLaunch 钩子保持原时序（launch 占位前）。红线：重启计数、钩子时序、
      // warn 文案逐位不变。
      return launchPinned(opts, port, {
        beforeLaunch: () => {
          // 显式新生命周期：复位主动 kill 标记 + 退避计数清零（与 start IIFE 同口径，
          // 恢复不计入崩溃退避）——launch 前置位，防 fork 后检查即杀新 child
          shutdownStarted = false
          restartCount = 0
        },
        successLog: (got) => logger.info('server-manager', `studio server 已恢复（session-end 观察窗自愈，端口 ${got} 钉住）`),
        failLog: (e) => logger.error('server-manager', 'session-end 自愈重启握手失败（API 不可用，建议重启应用）', e),
      })
    },
    hasPendingRestart(): boolean {
      return restartTimer !== null
    },
  }
}
