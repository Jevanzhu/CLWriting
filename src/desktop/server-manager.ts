/**
 * main 侧 studio server 子进程管理器（阶段 22 批次 K）。
 *
 * 批 U1（本文件当前态）：fork server-utility 入口 + parentPort 握手（ready 端口
 * 回传 / boot-error 信封）+ studioToken 首启生成/原子持久化（U-6 A）/启动读入内存
 * 一次、fork 一律复用内存值（二轮 F-5）+ stopChild（kill + 等退出）。
 * 批 U2 增：shutdown 指令下发 + shutdownStarted-exit 互斥门 + stdio pipe 日志
 * 转发（§3.5）；批 U3 增：exit 退避重启（钉住原端口 + 同一 token）。
 *
 * fork 以依赖注入暴露（测试换假件，不 mock electron 整模块）；入口路径按本模块
 * 产物位置派生（dist/desktop/server-utility.js，asar 内等价——R-6 同 server-main
 * dirname 派生先例）。env 不显式传——utilityProcess 缺省继承 process.env
 * （Electron typings 明文），批 U1 验收含该继承断言。
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
}

export interface ForkOptionsLike {
  serviceName?: string
}

export interface ServerManagerDeps {
  /** 缺省真实 utilityProcess.fork；测试注入假件 */
  fork?: (modulePath: string, args: string[], options: ForkOptionsLike) => UtilityProcessLike
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
  /** kill 当前 child 并等退出（before-quit 收尾 / bootstrap 重试清旧共用）；无 child 直通。 */
  stopChild(): Promise<void>
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
  let active: ActiveChild | null = null
  let starting: Promise<number> | null = null
  let tokenInMemory: string | null = null // F-5：启动读入一次，此后 fork 一律复用内存值
  return {
    async start(opts: StartStudioServerOptions): Promise<number> {
      if (starting) return starting // 并发 start 复用同一轮（bootstrap 重入防护之外的家底）
      starting = (async () => {
        // 重试/重启前清旧 child：等退出再 fork，避免端口/连接滞留（L-3 语义换轨，S-4）
        if (active) {
          log.warn('server-manager', 'start 时旧 child 仍在——先停旧再 fork')
          await this.stopChild()
        }
        if (tokenInMemory === null) tokenInMemory = loadOrCreateStudioToken(opts.userDataPath)
        const args: string[] = ['--user-data', opts.userDataPath, '--port', '0', '--token', tokenInMemory]
        if (opts.workDir) args.push('--dir', opts.workDir)
        if (opts.book) args.push('--book', opts.book)
        if (opts.mirrorConsole) args.push('--mirror-console')
        const proc = forkImpl(entryModulePath(), args, { serviceName: STUDIO_SERVICE_NAME })
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
      current.proc.kill()
      // SIGTERM 被吞的兜底：超时放行（退出事件迟到时 active 已由 exit 监听清空）
      await Promise.race([
        current.exited,
        new Promise<void>((r) => setTimeout(r, KILL_WAIT_TIMEOUT_MS).unref()),
      ])
    },
    isRunning(): boolean {
      return active !== null
    },
  }
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
