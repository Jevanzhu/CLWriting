/**
 * studio server 的 Electron utilityProcess 入口。
 *
 * main 侧 server-manager fork 本文件（dist/desktop/server-utility.js，asar 内路径等价），本入口只做：
 * 解析 fork 参数 → 经 server-boot 共享核心起 server → 把启动结果经 process.parentPort 默认消息通道
 * 握手回传（统一 parentPort，不引入 MessageChannelMain 端口转移）。
 *
 * 握手协议（消息形状与 server-manager 配对，测试两侧锚定）：
 * - child → main：{ type: 'ready', port }（listening 后每 child 一次）；
 *   { type: 'boot-error', code, message }（监听失败；发完即退出）；{ type: 'shutdown-done' }
 *  （shutdown 指令执行完回执）
 * - main → child：{ type: 'shutdown' }（执行 shutdownStudio 全流程——在途编排 abort/session/end
 *   落库 + server.close；该职责随 server 下沉，main 不再 import graceful-shutdown）；
 *   { type: 'update-check-result', result }（更新检查结果下发——检查在主进程跑，见下）
 *
 * 更新检查归主进程：子进程全局 fetch 不读系统代理，「只配系统代理」的用户永远收不到提示
 * （与下载腿的 net.fetch 不对称）。主进程跑完检查经默认消息通道下发结果，本入口落态
 * （`applyUpdateCheckResult`），端点（api/app-info.ts）照旧读模块态。子进程自己不出站。
 *
 * 日志通道：fork 注入 CLW_LOG_STDOUT=1，src/log stdout-only 模式直写 stdout 一行 JSON；main 以
 * stdio:pipe 收行解析重发落盘（单写者）。
 *
 * 退出路径共三条（后两条不依赖 main 发指令）：① boot-error（监听失败，回执后 exit(1)）；
 * ② shutdown 指令（main 的 before-quit 下发，收尾后回执 exit(0)）；③ 父进程消失（探活兜底，
 * 见 watchParentLiveness）——main 被强杀时既无 before-quit 指令、Electron 的「parent 退出即杀
 * 子」也不保证（强杀与部分平台形态下子进程留存），孤儿态仍占着书级锁与端口。
 */
import process from 'node:process'
import type http from 'node:http'
import {
  parseServerArgs,
  bootServerFromArgs,
  describeBootError,
  deriveStaticDir,
  type ParsedServerArgs,
} from './server-boot.js'
import { shutdownStudio } from './graceful-shutdown.js'
import { applyUpdateCheckResult, parsePushedUpdateCheckResult, UPDATE_RESULT_MESSAGE_TYPE } from '../update/check.js'
import { initLogging, log } from '../log/index.js'

/** parentPort 最小契约（Electron ParentPort 的 MessageEvent 包裹：消息在 e.data。
 *  `on` 的事件名放宽为 string：除文档化的 'message' 外还要挂 'close'，
 *  而 EventEmitter 基类对未文档化的事件名照收——挂了只会不触发、不会抛）。 */
export interface ParentPortLike {
  postMessage(message: unknown): void
  on(event: string, listener: (event: { data?: unknown }) => void): unknown
}

/** parent 探活轮询间隔。探测零成本，取 10s 是「孤儿早退」与「不热轮询」之间的折中：
 *  父被强杀时本进程最迟一个间隔后自退（终止到自退的上界 = 一个间隔 + 收尾预算）。 */
export const PARENT_LIVENESS_POLL_MS = 10_000

export interface ParentLivenessOpts {
  /** 当前父 pid（生产 = process.ppid）。POSIX 下父亡后子进程被重挂到 init，本值随之变化。 */
  ppid?: () => number
  /** 存活探测（生产 = process.kill(pid, 0)：不投信号只问存在）。 */
  alive?: (pid: number) => boolean
  /** 轮询间隔覆盖档 */
  intervalMs?: number
}

/** 存活探测：`kill(pid, 0)` 的 ESRCH 是「无此进程」；EPERM 是「有进程但无权探测」——按存活。 */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

/**
 * 装父进程探活，返回卸载函数。两条触发共用一次「父已不在」结论（只回调一次，触发后自卸载）：
 * ① parentPort 的 'close'（通道断开）——Electron 未文档化该事件（typings 只列 'message'），
 *    能来即用；
 * ② 低频轮询（主判据，两条判据取或）：现 ppid 与装载时不等（POSIX 父亡后重挂到 init）、
 *    或 `kill(ppid, 0)` 报 ESRCH（Windows 无重挂，ppid 值留存但进程已亡）。
 * 计时器 unref：探活不该成为「进程靠它活着」的理由，server 关掉后进程该退就退。
 */
export function watchParentLiveness(
  parentPort: ParentPortLike,
  onParentGone: () => void,
  opts: ParentLivenessOpts = {},
): () => void {
  const ppid = opts.ppid ?? ((): number => process.ppid)
  const alive = opts.alive ?? pidAlive
  const initialPpid = ppid()
  let fired = false
  const timer = setInterval(() => {
    if (ppid() !== initialPpid || !alive(initialPpid)) fire()
  }, opts.intervalMs ?? PARENT_LIVENESS_POLL_MS)
  timer.unref?.()
  function stop(): void {
    clearInterval(timer)
  }
  function fire(): void {
    if (fired) return
    fired = true
    stop()
    onParentGone()
  }
  parentPort.on('close', () => fire())
  return stop
}

export interface UtilityEntryDeps {
  /** 探活覆盖档（缺省 = process.ppid + kill 探测 + 10s 轮询；测试注入假 ppid 与短间隔） */
  parentLiveness?: ParentLivenessOpts
}

/**
 * utility 入口主流程（独立导出以便测试；顶层仅接线）。
 * 返回 server 实例（测试断言用）；无 parentPort 的非 utility 态打印后由调用方处置。
 */
export function runUtilityEntry(
  parentPort: ParentPortLike,
  parsed: ParsedServerArgs,
  deps: UtilityEntryDeps = {},
): http.Server {
  const server = bootServerFromArgs(parsed, deriveStaticDir(import.meta.url), {
    onReady: (port) => {
      parentPort.postMessage({ type: 'ready', port })
    },
    onBootError: (err) => {
      // 信封化（EADDRINUSE 中文口径）后回传再退出——main 侧对首启失败弹原生对话框
      const envelope = describeBootError(err, parsed.port)
      parentPort.postMessage({ type: 'boot-error', code: envelope.code, message: envelope.message })
      // 紧随 postMessage 的同步 exit 可能截断跨进程投递（消息尚未
      // flush 即随进程消亡，main 只见 child 退出不见 boot-error）——让出一个事件循环
      // 轮次（setImmediate）给投递 flush 后再退
      setImmediate(() => process.exit(1))
    },
  })
  /** 收尾退出（shutdown 指令与父进程消失两条触发共用）：shutdown-done 回执（及随之的
   *  exit）严格后置于 shutdownStudio 全流程——该流程含在途 Worker 线程/保存队列的有界
   *  收尾（graceful-shutdown），postMessage/exit 只在 finally 执行，即 teardown 完成后
   *  才允许退出；硬 exit 仍作最终兜底（main 侧另有总超时 + kill），child 永不挂死。
   *  只跑一次：收尾流程重复进入会对在途编排再做一轮 abort/session 落库。 */
  let shutdownStarted = false
  const shutdownAndExit = (): void => {
    if (shutdownStarted) return
    shutdownStarted = true
    void shutdownStudio(() => parsed.workDir, server)
      .catch(() => {}) // 收尾失败也必须回执退出——main 总超时兜底，不让 child 挂死
      .finally(() => {
        parentPort.postMessage({ type: 'shutdown-done' })
        // 同 boot-error——回执先经一个事件循环轮次 flush，再退出（main 总超时
        // 3.5s 远宽于一轮 setImmediate，时序上无风险）
        setImmediate(() => process.exit(0))
      })
  }
  // 第三条退出路径：父进程消失（强杀/崩溃）——走与 shutdown 指令同一条收尾。
  // 父侧已亡，回执无人收，仍走统一路径：回执与收尾原子成对，不分叉出第二套退出时序。
  watchParentLiveness(parentPort, shutdownAndExit, deps.parentLiveness)
  // main → child：shutdown 指令（before-quit 下发）
  parentPort.on('message', (event: { data?: unknown }) => {
    const msg = event.data as { type?: string; result?: unknown } | undefined
    // 更新检查结果下发（主进程跑完检查后送；见文件头「更新检查归主进程」）
    if (msg?.type === UPDATE_RESULT_MESSAGE_TYPE) {
      applyUpdateCheckResult(parsePushedUpdateCheckResult(msg.result))
      return
    }
    if (msg?.type !== 'shutdown') return
    shutdownAndExit()
  })
  return server
}

/**
 * 顶层 fatal 兜底——unhandledRejection / uncaughtException。
 * 此前无任何 handler：漏 catch 的异步 rejection 直接走 Electron utilityProcess 崩溃
 * 重启重路径且丢现场（无日志可查）。现经现有 stdout 日志通道（fork 注入
 * CLW_LOG_STDOUT=1 → src/log stdout-only 直写一行 JSON，main 收行转发落盘）记
 * error 后主动 process.exit(1)——记日志后主动退出，交给 restart 退避（server-manager
 * 的 0/5s/15s 三档 + 3 次封顶接管，非静默崩溃），现场可查。
 * exit 改 setImmediate 让一轮（对齐）——stdout pipe 异步写 flush 后再退，
 * 崩溃诊断行不随进程消亡丢失。
 * 导出供测试直驱；仅真实 utility 形态（有 parentPort）在模块顶层接线，vitest
 * import 态不注册（防测试 worker 的无关 rejection 触发 exit 杀掉测试进程）。
 */
export function installFatalExitHandlers(): void {
  // 提前激活日志通道：CLW_LOG_STDOUT=1（fork 注入）时 initLogging 短路为 stdout-only，
  // boot 前（模块加载/握手期）的 fatal 也走同一 JSON 行通道；startServer 内会再 init
  // （幂等）。未注入 env 的形态不动日志态（保持缺省 console 镜像）。
  if (process.env['CLW_LOG_STDOUT'] === '1') {
    initLogging({ logsDir: null, mirrorConsole: false })
  }
  // 两 fatal 路径 exit 对齐（onBootError/shutdown-done 同款
  // 让轮）——log.error 经 stdout pipe 异步写，同步 exit 可能在行 flush 前随进程消亡，
  // 崩溃现场唯一诊断来源丢失；setImmediate 让出一轮再退（restart 退避不差这一轮）
  process.on('uncaughtException', (err) => {
    log.error('server-utility', 'uncaughtException——记日志后主动退出，交给 restart 退避', err)
    setImmediate(() => process.exit(1))
  })
  process.on('unhandledRejection', (reason) => {
    log.error('server-utility', 'unhandledRejection——记日志后主动退出，交给 restart 退避', reason)
    setImmediate(() => process.exit(1))
  })
}

const parentPort = process.parentPort
if (!parentPort) {
  // 无 parentPort 的两种形态分开留痕（原共用一条消息，测试态 import 的预期探针
  // 与误用直跑的报错在日志里不可区分）——vitest 探针带 [vitest] 前缀 + info 级语义，
  // 误用直跑保持 error 口径不变：
  if (process.env['VITEST'] === 'true') {
    // vitest import 本模块做单测时同样无 parentPort：只留痕不退出，避免杀 worker
    console.error(
      '[server-utility][vitest] 测试态 import（无 process.parentPort，属预期）：本入口运行态仅供 Electron utilityProcess fork 使用',
    )
  } else {
    // 非 utility 进程态（误用 node 直跑等）——没有回传通道，stdout 留痕后退出
    console.error('[server-utility] 缺少 process.parentPort：本入口仅供 Electron utilityProcess fork 使用')
    process.exit(1)
  }
} else {
  installFatalExitHandlers() // fatal 兜底（仅真实 utility 形态）
  runUtilityEntry(parentPort, parseServerArgs(process.argv))
}
