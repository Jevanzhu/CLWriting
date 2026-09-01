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

/** fork options 可辨识名：getAppMetrics 单列（ProcessMetric.name），S-12 */
export const STUDIO_SERVICE_NAME = 'studio-server'

/** 握手超时上限：child 挂起（模块加载卡死等）时兜底走启动失败路径，防 main 永久无窗 */
const HANDSHAKE_TIMEOUT_MS = 30_000
/** stopChild 等 child 退出的上限：kill 后仍不退（SIGTERM 被吞）则放行，防退出链挂死 */
const KILL_WAIT_TIMEOUT_MS = 2_000
/**
 * shutdown 总超时：不等 shutdown-done 回执的兜底（与拆分前 before-quit 2s 同量级，§3.4 时序 4）。
 * E-1（第五十三轮）：child 侧 graceful-shutdown 最坏预算 = close 1.5s + settle 1.5s 串行
 * ≈3s——原 2s 会在收尾窗口内强杀，打断 session/end 落库；提到 3.5s 覆盖 child 最坏
 * 预算（改动面最小、语义直白：main 兜底必须 ≥ child 自身兜底之和，否则兜底变打断）。
 * 测试经 shutdownTotalMs 注入缩短，不依赖本值保快。
 */
export const SHUTDOWN_TOTAL_TIMEOUT_MS = 3_500
/** 崩溃退避序列（第 1/2/3 次自动重启前的等待；U-2 建议立即/5s/15s） */
const RESTART_BACKOFF_MS: readonly number[] = [0, 5_000, 15_000]
/** 自动重启次数上限：第 3 次重启后的再崩溃不再自动重启，转 onRestartExhausted 决断 */
const RESTART_MAX_ATTEMPTS = 3
/** ready 后稳定窗口：child 存活过此窗口即清零重启计数（U-2/S-9 偶发单崩不累计） */
const STABILITY_RESET_MS = 5 * 60_000

/** 启动失败（boot-error 信封 / 握手超时 / 启动途中退出）——main 首启弹对话框口径 */
export class ServerBootError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'ServerBootError'
  }
}

/** utilityProcess.fork 返回面的最小契约（测试假件同构） */
export interface UtilityProcessLike {
  on(event: 'message', listener: (message: unknown) => void): unknown
  once(event: 'message', listener: (message: unknown) => void): unknown
  once(event: 'exit', listener: (code: number) => void): unknown
  postMessage(message: unknown): void
  kill(): boolean
  pid?: number
  /** stdio:'pipe' 时的子进程 stdout（转发日志行）；缺省 inherit 形态为 null */
  stdout?: NodeJS.ReadableStream | null
  /** stdio:'pipe' 时的子进程 stderr（Node 警告/V8 诊断整行进档） */
  stderr?: NodeJS.ReadableStream | null
}

export interface ForkOptionsLike {
  serviceName?: string
  stdio?: 'pipe' | 'inherit'
  env?: Record<string, string | undefined>
}

/** 日志通道最小契约（缺省 src/log；测试注入捕获件） */
export interface LogLike {
  error(tag: string, msg: string, err?: unknown): void
  warn(tag: string, msg: string, err?: unknown): void
  info(tag: string, msg: string): void
}

export interface ServerManagerDeps {
  /** 缺省真实 utilityProcess.fork；测试注入假件 */
  fork?: (modulePath: string, args: string[], options: ForkOptionsLike) => UtilityProcessLike
  /** 缺省 src/log；测试注入捕获件 */
  logger?: LogLike
  /** shutdown 总超时（指令下发到强杀兜底前）；测试注入缩短保快 */
  shutdownTotalMs?: number
  /** kill 后等退出的上限；测试注入缩短保快 */
  killWaitMs?: number
  /** 退避序列（第 1/2/3 次重启前等待）；缺省 [0, 5000, 15000]，测试注入缩短保快 */
  backoffMs?: readonly number[]
  /** ready 后稳定窗口，届时重启计数清零（U-2/S-9）；缺省 5 分钟 */
  stabilityResetMs?: number
  /**
   * 3 次自动重启耗尽后的用户决断（main 接原生对话框：重启服务/退出）：
   * 'restart' = 计数清零立即人工重启；'quit' = 不再重启（main 侧自行 app.quit）。
   * 缺省 'quit'——无接线不盲启（测试/降级态安全缺省）。
   */
  onRestartExhausted?: () => 'restart' | 'quit'
}

export interface StartStudioServerOptions {
  /** null = welcome 态（fork 不带 --dir，S-8） */
  workDir: string | null
  /** Electron userData 目录（child 无 app 对象，经 --user-data 下发） */
  userDataPath: string
  /** --book 下沉的书名（main 侧已 resolveInitialBook，U-1 附带） */
  book?: string | null
  /** dev 态传 true → child 附 --mirror-console（打包态 false 不传） */
  mirrorConsole?: boolean
}

interface ActiveChild {
  proc: UtilityProcessLike
  port: number
  /** ready 后注册：exit 事件 resolve（stopChild 等退出用；U3 重启也挂此处） */
  exited: Promise<void>
}

export interface StudioServerManager {
  /** fork + 握手，resolve 实际监听端口（ready 消息回传）。旧 child 在途时先停旧再 fork；
   *  显式 start 开新生命周期（退避计数清零、挂起重启作废）。 */
  start(opts: StartStudioServerOptions): Promise<number>
  /** kill 当前 child 并等退出（bootstrap 重试清旧共用）；无 child 直通。主动停机：
   *  取消挂起重启 + S-5 门置位（随后的 exit 不触发自动重启）。 */
  stopChild(): Promise<void>
  /**
   * 优雅停机（before-quit 收尾）：下发 shutdown 指令 → shutdownStudio 落定 →
   * shutdown-done 回执 / 总超时（3.5s，E-1）/ exit 三路先到为准；窗口内未退则 kill 兜底。
   * 幂等；与 stopChild 同属主动停机——均置 shutdownStarted（S-5，批 U3 重启门消费）。
   */
  shutdown(): Promise<void>
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
  const killWaitMs = deps.killWaitMs ?? KILL_WAIT_TIMEOUT_MS
  const backoffMs = deps.backoffMs ?? RESTART_BACKOFF_MS
  const stabilityResetMs = deps.stabilityResetMs ?? STABILITY_RESET_MS
  let active: ActiveChild | null = null
  let starting: Promise<number> | null = null
  // E-9a（第五十三轮）：在途 start 的关键 opts 快照——并发 start 复用同一轮前校验
  // 一致性，不一致 fail-closed 直接 reject（不静默吞没后到调用方的配置）
  let startingOpts: StartStudioServerOptions | null = null
  let tokenInMemory: string | null = null // F-5：启动读入一次，此后 fork 一律复用内存值
  // S-5 互斥门：主动停机（shutdown/stopChild）置位，child exit 属预期不触发重启；
  // start/shutdown/stopChild 均取消挂起重启——退出/换轮途中 fork 新 child 即孤儿。
  let shutdownStarted = false
  /** B-7（第六十轮）：停机流程生命周期门（shutdown 入口置位 / 收口复位）——与
   *  shutdownStarted（主动 kill 标记，stopActiveChild 也置位且不随收口复位）分工。 */
  let shuttingDown = false
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
    for (const k of Object.keys(childEnv)) {
      if (k.toUpperCase() === 'CLW_STUDIO_TOKEN') delete childEnv[k]
    }
    childEnv['CLW_STUDIO_TOKEN'] = tokenInMemory
    childEnv['CLW_LOG_STDOUT'] = '1'
    const proc = forkImpl(entryModulePath(), args, {
      serviceName: STUDIO_SERVICE_NAME,
      stdio: 'pipe',
      env: childEnv,
    })
    // S1（五十九轮）：fork 后发现停机已置位 → 立即杀掉新 child 并按启动失败收口。
    // 在途 start/自动重启（X-3 starting 通道）的握手窗口内 shutdown/stopChild 落地时，
    // shutdown 侧 settleStarting 只能等到 handshake 完成——fork 即杀把窗口收窄到
    // 「已 fork 未检查」的同步缝隙，新 child 不再漏杀成孤儿（优雅停机面收口）。
    if (shutdownStarted) {
      proc.kill()
      throw new ServerBootError('SHUTDOWN', 'studio server 启动途中收到停机指令，已中止新 child')
    }
    forwardChildStdio(proc, logger) // 握手前接线——boot 期日志不丢
    const port = await handshake(proc, logger)
    // 稳定窗口计时（unref 不拖退出）：到点仍是他为 active 才清零
    setTimeout(() => {
      if (active?.proc === proc) restartCount = 0
    }, stabilityResetMs).unref()
    const exited = new Promise<void>((resolveExit) => {
      proc.once('exit', () => {
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
      const choice = deps.onRestartExhausted?.() ?? 'quit'
      if (choice === 'restart') {
        restartCount = 0 // 人工重启计一次全新周期
        scheduleRestart()
      }
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

  async function doRestart(): Promise<void> {
    if (shutdownStarted) return // 等待窗口内被停机（S-5）
    const opts = lastOpts
    const port = pinnedPort
    if (!opts || port === null) return
    // X-3（第五十六轮）：重启全程复用 starting 互斥通道——此前 doRestart 直连 launch
    // 不置 starting，restartTimer 已触发且握手未完成的窗口内 start() 三守卫
    // （starting/active/hasPendingRestart）皆空 → 再 fork 双 child，后完成者赢得
    // active、先完成者孤儿无人杀。占位后并发 start 同参数复用在途重启轮（含钉住
    // 端口语义）、参数不一致沿用 E-9a fail-closed reject；finally 清空归还通道。
    startingOpts = opts
    starting = (async () => launch(opts, String(port)))()
    try {
      const got = await starting
      logger.info('server-manager', `studio server 已自动重启（端口 ${got} 钉住）`)
    } catch (e) {
      // 重启期握手失败（EXIT/EADDRINUSE 残留端口等）按退避继续（§3.4 时序 3）
      logger.error('server-manager', '自动重启握手失败，按退避序列继续', e)
      scheduleRestart()
    } finally {
      starting = null
      startingOpts = null
    }
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
        // S1（五十九轮）：停机门复位移到 IIFE 首行（首个 await 前同步执行）——原在
        // stopActiveChild 的 await 之后复位，shutdown 恰落在该等待窗内会被静默清掉
        // （launch 的 fork 后检查随之失守）。显式 start 开新生命周期在占通道瞬间生效。
        shutdownStarted = false
        cancelPendingRestart() // 显式换轮作废挂起重启（与 stopChild 的取消面互补）
        // 重试/重启前清旧 child：等退出再 fork，避免端口/连接滞留（L-3 语义换轨，S-4）
        if (active) {
          logger.warn('server-manager', 'start 时旧 child 仍在——先停旧再 fork')
          await stopActiveChild()
        }
        // stopActiveChild 置位的停机门复位（换轮继续 launch）；并发 shutdown 已在
        // settleStarting 等 starting 落定，不会在此窗漏网
        shutdownStarted = false
        restartCount = 0 // 显式 start 开新周期（bootstrap 语义，非崩溃续期）
        return await launch(opts, '0')
      })()
      try {
        return await starting
      } finally {
        starting = null
        startingOpts = null
      }
    },
    async stopChild(): Promise<void> {
      // S1（五十九轮）：在途 start/自动重启先落定（catch 握手失败）再判 active——
      // 握手窗口内 active===null，只看 active 会让刚 fork 的 child 漏杀成孤儿
      await settleStarting('stopChild')
      await stopActiveChild()
    },
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
        // 已置位）会即杀新 child，此处等 handshake 收口拿到 active 走优雅停机链
        await settleStarting('shutdown')
        cancelPendingRestart() // 退避等待期退出：挂起重启作废（不 fork 孤儿）
        const current = active
        if (!current) return
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
        logger.info('server-manager', 'studio server 子进程已停机（shutdown 指令链路）')
      } else {
        logger.warn('server-manager', 'shutdown 超时未回执，已强杀兜底')
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
      }
    },
    isRunning(): boolean {
      return active !== null
    },
    hasPendingRestart(): boolean {
      return restartTimer !== null
    },
  }
}

/** 可 unref 的延时（不拖进程退出；vitest 下也不挂 worker） */
function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms).unref())
}

/**
 * child stdout/stderr → main logger 转发（§3.5 单写者的 main 侧半边）。
 * stdout 行 = src/log stdout-only 输出的 JSON 行（与落盘行同构），按 level 重发；
 * err 字段重建 Error（F-3：name/message/stack 透传，重发再序列化形状不变）；
 * 非 JSON 行 / 字段不完整：原文整行兜底进档（不吞 boot 报错等裸输出）。
 * stderr（Node 警告/V8 诊断）无 JSON 语义，整行按 warn 进档——崩溃取证主线索。
 */
/** 内存闸（2026-08-24 审计 D1）：单行缓冲上限（1MB，utf8 解码后按字符计——与字节
 *  同量级）——child 持续输出无换行内容（日志巨行 / \r 型进度条）时 buf 不再无界
 *  线性增长；超限强制截断出行（余量留在 buf 继续累积，下一换行/下一轮超限收口） */
export const MAX_LINE_CHARS = 1 << 20

function forwardChildStdio(proc: UtilityProcessLike, logger: LogLike): void {
  // 内存闸（2026-08-24 审计 D1）：单行超限强制截断的计数告警（stdout/stderr 同口径）
  const warnForced = (side: 'stdout' | 'stderr') => (count: number) =>
    logger.warn('server-manager', `child ${side} 单行超 ${MAX_LINE_CHARS >> 20}MB 无换行，已强制截断出行（累计 ${count} 次）`)
  splitLines(proc.stdout, (line) => forwardLogLine(line, logger), warnForced('stdout'))
  splitLines(proc.stderr, (line) => logger.warn('server-proc', line), warnForced('stderr'))
}

/** （导出供测试直测解析口径）child 输出 → 行切分。
 *  onWarn：每次强制截断出行时回调（入参为累计次数），缺省不告警。 */
export function splitLines(
  out: NodeJS.ReadableStream | null | undefined,
  onLine: (line: string) => void,
  onWarn?: (forcedCount: number) => void,
): void {
  if (!out) return
  try {
    out.setEncoding?.('utf8')
  } catch {
    /* 假件可能未实现：按原 chunk 处理 */
  }
  let buf = ''
  let forced = 0
  out.on('data', (chunk: unknown) => {
    buf += String(chunk)
    let nl = buf.indexOf('\n')
    while (nl !== -1) {
      const line = buf.slice(0, nl).trim()
      buf = buf.slice(nl + 1)
      if (line) onLine(line)
      nl = buf.indexOf('\n')
    }
    // 内存闸（2026-08-24 审计 D1）：无换行残余超单行上限——强制截断出行 + 计数告警。
    // 只作用于无换行残余：带换行的正常行（哪怕超长）行为不变（瞬时大行不无界累积）
    if (buf.length > MAX_LINE_CHARS) {
      const line = buf.slice(0, MAX_LINE_CHARS).trim()
      buf = buf.slice(MAX_LINE_CHARS)
      forced++
      onWarn?.(forced)
      if (line) onLine(line)
    }
  })
  out.on('error', () => {}) // 流异常不反噬 main：转发尽力而为，丢行不丢进程
}

/** 单行转发（导出供测试直测解析口径）；level 不可辨识与解析失败同走原文兜底。 */
export function forwardLogLine(line: string, logger: LogLike): void {
  let parsed: { level?: unknown; tag?: unknown; msg?: unknown; err?: unknown }
  try {
    parsed = JSON.parse(line) as typeof parsed
  } catch {
    logger.info('server-proc', line)
    return
  }
  const level = parsed.level
  if (level !== 'error' && level !== 'warn' && level !== 'info') {
    logger.info('server-proc', line)
    return
  }
  const tag = typeof parsed.tag === 'string' ? parsed.tag : 'server-proc'
  const msg = typeof parsed.msg === 'string' ? parsed.msg : line
  if (level === 'info') logger.info(tag, msg)
  else if (level === 'warn') logger.warn(tag, msg, reconstructErr(parsed.err))
  else logger.error(tag, msg, reconstructErr(parsed.err))
}

/** child 行 err 字段 {name,message,stack?} → Error 重建（F-3 透传；缺字段按无 err 处理） */
function reconstructErr(raw: unknown): Error | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const r = raw as { name?: unknown; message?: unknown; stack?: unknown }
  if (typeof r.message !== 'string') return undefined
  const e = new Error(r.message)
  if (typeof r.name === 'string') e.name = r.name
  if (typeof r.stack === 'string') e.stack = r.stack
  return e
}

/**
 * proc 级 kill+等退出+SIGKILL 升级（R27-90（二十七轮）自 killAwaitEscalating 抽出为模块级：
 * 握手超时路径同用）。exit promise 由调用方供给——当值 child 用 ActiveChild.exited；
 * 握手超时的未就绪 child 现挂 once('exit')。时序：kill 后等 killWaitMs，仍活且 pid 在手
 * 升级 SIGKILL，再等一轮 killWaitMs 作最终兜底。签名带 killWaitMs/logger：模块级函数
 * 不进工厂闭包，两处调用方各传自己的注入值。
 */
async function killProcAwaitEscalating(
  proc: UtilityProcessLike,
  exited: Promise<void>,
  context: string,
  killWaitMs: number,
  logger: LogLike,
): Promise<void> {
  const didExit = await Promise.race([exited.then(() => true), delay(killWaitMs).then(() => false)])
  if (didExit) return
  // R28-21（二十八轮）：升级 SIGKILL 前才读 pid（原在入口快照）——killWaitMs（2s）窗内
  // 子进程可能已死亡且 pid 被系统复用，按入口旧 pid 盲杀会误伤无关进程（极窄理论窗）。
  // Electron 语义：UtilityProcess 退出后 pid 置 undefined（R26-87 注引 electron.d.ts：
  // spawn 前/exit 后为 undefined），重读 undefined = 已退出而 exit 事件竞态迟到 → 不升级，
  // 维持「超时放行」最终兜底；仍为在册 pid 才强杀。残余窗口如实记档：重读到 process.kill
  // 之间仍有微秒级缝隙，彻底闭合需句柄级 kill（utilityProcess 面未暴露），超本修法范畴。
  const pid = proc.pid
  if (pid === undefined) return // 无 pid（未 spawn 成功/窗口内已退出）：维持原「超时放行」口径
  try {
    process.kill(pid, 'SIGKILL')
    logger.warn('server-manager', `${context}：kill 后 ${killWaitMs}ms 仍未退出（SIGTERM 疑似被吞），已升级 SIGKILL 强杀（pid=${pid}）`)
  } catch (e) {
    logger.warn('server-manager', `${context}：SIGKILL 升级失败（child 可能已自行退出）：${e instanceof Error ? e.message : String(e)}`)
  }
  await Promise.race([exited, delay(killWaitMs)])
}

/**
 * 每 fork 一轮握手（S-5：退避重启的新 child 各发各的 ready，不假设全局一次性）。
 * ready → resolve 端口；boot-error 信封 → ServerBootError；启动途中 exit → 同类错误；
 * 30s 超时兜底（child 挂起）→ kill+等退出+SIGKILL 升级后按启动失败收口。settle 后残余
 * 监听挂在 child 对象上随其消亡，无跨 child 泄漏（exit persistent 版本由 start 成功路径另挂）。
 */
function handshake(proc: UtilityProcessLike, logger: LogLike): Promise<number> {
  return new Promise<number>((resolveRaw, rejectRaw) => {
    let settled = false
    const settle = (finish: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      finish()
    }
    const timer = setTimeout(
      () =>
        settle(() => {
          proc.kill()
          // R27-90（二十七轮）：kill 不再 fire-and-forget——R26-87 已实证 SIGTERM 可被吞，
          // 唯此第三条 kill 路径漏应用同族纪律，卡死 child 会占住端口喂重启 EADDRINUSE
          // 循环/首启 quit 后成孤儿。等退出+升级完成后再按启动失败收口，重启链拿到的是
          // 无端口残留的干净现场。
          const exited = new Promise<void>((resolveExit) => {
            proc.once('exit', () => resolveExit())
          })
          void killProcAwaitEscalating(
            proc,
            exited,
            'studio server 握手超时',
            KILL_WAIT_TIMEOUT_MS,
            logger,
          ).finally(() =>
            rejectRaw(new ServerBootError('HANDSHAKE_TIMEOUT', 'studio server 子进程启动握手超时（30s 无 ready）')),
          )
        }),
      HANDSHAKE_TIMEOUT_MS,
    )
    timer.unref()
    proc.on('message', (message: unknown) => {
      const m = message as { type?: string; port?: unknown; code?: unknown; message?: unknown }
      if (m?.type === 'ready' && typeof m.port === 'number') {
        settle(() => resolveRaw(m.port as number))
      } else if (m?.type === 'boot-error') {
        settle(() =>
          rejectRaw(new ServerBootError(String(m.code ?? 'UNKNOWN'), String(m.message ?? 'server 启动失败'))),
        )
      }
    })
    proc.once('exit', (code: number) =>
      settle(() => rejectRaw(new ServerBootError('EXIT', `studio server 子进程启动途中退出（exit code ${code}）`))),
    )
  })
}
