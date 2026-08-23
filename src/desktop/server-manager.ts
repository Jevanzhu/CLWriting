/**
 * main 侧 studio server 子进程管理器（阶段 22 批次 K）。
 *
 * 批 U1：fork server-utility 入口 + parentPort 握手（ready 端口回传 / boot-error
 * 信封）+ studioToken 首启生成/原子持久化（U-6 A）/启动读入内存一次、fork 一律复用
 * 内存值（二轮 F-5）+ stopChild（kill + 等退出）。
 * 批 U2（本文件当前态）：shutdown 指令下发 + shutdown-done 回执/2s 总超时强杀 +
 * shutdownStarted 状态门（S-5：置位后 child exit 不再触发重启，批 U3 退避逻辑消费）
 * + stdio:pipe 日志单写者转发（§3.5：CLW_LOG_STDOUT=1 注入 + JSON 行解析按
 * level/tag/err 重发，err 透传 F-3，坏行原文兜底不套 JSON）。
 * 批 U3 增：exit 退避重启（钉住原端口 + 同一 token，消费 shutdownStarted 门）。
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
/** shutdown 总超时：不等 shutdown-done 回执的兜底（与拆分前 before-quit 2s 同量级，§3.4 时序 4） */
const SHUTDOWN_TOTAL_TIMEOUT_MS = 2_000

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
  /** fork + 握手，resolve 实际监听端口（ready 消息回传）。旧 child 在途时先停旧再 fork。 */
  start(opts: StartStudioServerOptions): Promise<number>
  /** kill 当前 child 并等退出（bootstrap 重试清旧共用）；无 child 直通。 */
  stopChild(): Promise<void>
  /**
   * 优雅停机（before-quit 收尾）：下发 shutdown 指令 → shutdownStudio 落定 →
   * shutdown-done 回执 / 2s 总超时 / exit 三路先到为准；窗口内未退则 kill 兜底。
   * 幂等；与 stopChild 同属主动停机——均置 shutdownStarted（S-5，批 U3 重启门消费）。
   */
  shutdown(): Promise<void>
  /** 是否有已握手完成的 child 在跑 */
  isRunning(): boolean
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
  let active: ActiveChild | null = null
  let starting: Promise<number> | null = null
  let tokenInMemory: string | null = null // F-5：启动读入一次，此后 fork 一律复用内存值
  // S-5 互斥门：主动停机（shutdown/stopChild）置位，child exit 属预期不触发重启
  // （批 U3 退避逻辑消费）；每轮 start 复位——新一轮生命周期开始。
  let shutdownStarted = false
  return {
    async start(opts: StartStudioServerOptions): Promise<number> {
      if (starting) return starting // 并发 start 复用同一轮（bootstrap 重入防护之外的家底）
      starting = (async () => {
        // 重试/重启前清旧 child：等退出再 fork，避免端口/连接滞留（L-3 语义换轨，S-4）
        if (active) {
          logger.warn('server-manager', 'start 时旧 child 仍在——先停旧再 fork')
          await this.stopChild()
        }
        shutdownStarted = false
        if (tokenInMemory === null) tokenInMemory = loadOrCreateStudioToken(opts.userDataPath)
        const args: string[] = ['--user-data', opts.userDataPath, '--port', '0', '--token', tokenInMemory]
        if (opts.workDir) args.push('--dir', opts.workDir)
        if (opts.book) args.push('--book', opts.book)
        if (opts.mirrorConsole) args.push('--mirror-console')
        // stdio:pipe + CLW_LOG_STDOUT=1（§3.5 单写者）：child 日志只走 stdout JSON 行，
        // 由 main 收行重发落盘；env 展开拷贝，不污染 main 自身 process.env
        const proc = forkImpl(entryModulePath(), args, {
          serviceName: STUDIO_SERVICE_NAME,
          stdio: 'pipe',
          env: { ...process.env, CLW_LOG_STDOUT: '1' },
        })
        forwardChildStdio(proc, logger) // 握手前接线——boot 期日志不丢
        const port = await handshake(proc)
        const exited = new Promise<void>((resolveExit) => {
          proc.once('exit', () => {
            if (active?.proc === proc) active = null
            resolveExit()
          })
        })
        active = { proc, port, exited }
        return port
      })()
      try {
        return await starting
      } finally {
        starting = null
      }
    },
    async stopChild(): Promise<void> {
      const current = active
      if (!current) return
      shutdownStarted = true // 主动 kill：随后的 exit 是预期收口，不触发重启（S-5）
      current.proc.kill()
      // SIGTERM 被吞的兜底：超时放行（退出事件迟到时 active 已由 exit 监听清空）
      await Promise.race([current.exited, delay(killWaitMs)])
    },
    async shutdown(): Promise<void> {
      if (shutdownStarted) return // 幂等：before-quit 可能多次触发
      shutdownStarted = true // 先置位后下发：exit 早于 shutdown-done 到达也不误判崩溃（S-5）
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
        // 超时未退 / 回执后滞留：强杀兜底，与拆分前 before-quit 2s 超时同口径（§3.4 时序 4）
        current.proc.kill()
        await Promise.race([current.exited, delay(killWaitMs)])
      }
    },
    isRunning(): boolean {
      return active !== null
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
function forwardChildStdio(proc: UtilityProcessLike, logger: LogLike): void {
  splitLines(proc.stdout, (line) => forwardLogLine(line, logger))
  splitLines(proc.stderr, (line) => logger.warn('server-proc', line))
}

function splitLines(out: NodeJS.ReadableStream | null | undefined, onLine: (line: string) => void): void {
  if (!out) return
  try {
    out.setEncoding?.('utf8')
  } catch {
    /* 假件可能未实现：按原 chunk 处理 */
  }
  let buf = ''
  out.on('data', (chunk: unknown) => {
    buf += String(chunk)
    let nl = buf.indexOf('\n')
    while (nl !== -1) {
      const line = buf.slice(0, nl).trim()
      buf = buf.slice(nl + 1)
      if (line) onLine(line)
      nl = buf.indexOf('\n')
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
 * 每 fork 一轮握手（S-5：退避重启的新 child 各发各的 ready，不假设全局一次性）。
 * ready → resolve 端口；boot-error 信封 → ServerBootError；启动途中 exit → 同类错误；
 * 30s 超时兜底（child 挂起）→ kill 后按启动失败收口。settle 后残余监听挂在 child
 * 对象上随其消亡，无跨 child 泄漏（exit persistent 版本由 start 成功路径另挂）。
 */
function handshake(proc: UtilityProcessLike): Promise<number> {
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
          rejectRaw(new ServerBootError('HANDSHAKE_TIMEOUT', 'studio server 子进程启动握手超时（30s 无 ready）'))
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
