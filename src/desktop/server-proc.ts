/**
 * studio server 子进程管理的进程管理缝 —— 自 src/desktop/server-manager.ts 拆出。
 *
 * （⑤④产品巨件拆分波3）：server-manager.ts（1127 行）两缝
 * 纯移动拆分（零行为变化、零逻辑改写，代码与历史注释原样随迁）。本文件承载进程
 * 管理族：proc 级 kill+等退出+SIGKILL 升级纪律 killProcAwaitEscalating（
 * 模块级形态）、fork 握手 handshake、可 unref 延时 delay；两缝共用契约与常量随
 * 本族单源迁此——进程契约 UtilityProcessLike / 日志通道契约 LogLike / 启动失败
 * ServerBootError / 握手与 kill 超时常量 HANDSHAKE_TIMEOUT_MS、KILL_WAIT_TIMEOUT_MS。
 * 依赖方向单向（无环回引）：残核 server-manager.ts 与 server-log.ts 自本文件直接
 * import（server-log 仅 type-only 取两契约，编译期擦除不构成运行时回边），本文件
 * 不回引残核——顶层求值常量单源本文件，不经环回 re-export 链被引（state
 * 拆分同款纪律）。服务器状态机 createStudioServerManager（约 620 行，G 普查批
 * 不动清单第一项）留 server-manager.ts，本批零触碰其函数体；迁出公开导出
 * （ServerBootError / LogLike）经 server-manager.ts 逐名 re-export 桥接，全库
 * 消费方 import 面零改动。
 */
import { errMsg } from '../log/index.js'

/** 握手超时上限：child 挂起（模块加载卡死等）时兜底走启动失败路径，防 main 永久无窗 */
const HANDSHAKE_TIMEOUT_MS = 30_000
/** stopChild 等 child 退出的上限：kill 后仍不退（SIGTERM 被吞）则放行，防退出链挂死 */
export const KILL_WAIT_TIMEOUT_MS = 2_000

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
  /** （GLM-5.3 修复批）：Electron 在「进程无法
   *  spawn」「被异常终止（V8 FatalError/OOM 等）」时经 'error' 事件抛诊断（三参：
   *  type（如 "FatalError"）/location/完整 V8 崩溃报告文本）——EventEmitter 语义下
   *  无监听即 uncaughtException 崩主进程，本接口此前漏此事件面（且 V8 级根因丢失）。 */
  on(event: 'error', listener: (type: string, location: string, report: string) => void): unknown
  postMessage(message: unknown): void
  kill(): boolean
  pid?: number
  /** stdio:'pipe' 时的子进程 stdout（转发日志行）；缺省 inherit 形态为 null */
  stdout?: NodeJS.ReadableStream | null
  /** stdio:'pipe' 时的子进程 stderr（Node 警告/V8 诊断整行进档） */
  stderr?: NodeJS.ReadableStream | null
}

/** 日志通道最小契约（缺省 src/log；测试注入捕获件） */
export interface LogLike {
  error(tag: string, msg: string, err?: unknown): void
  warn(tag: string, msg: string, err?: unknown): void
  info(tag: string, msg: string): void
}

/** 可 unref 的延时（不拖进程退出；vitest 下也不挂 worker） */
export function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms).unref())
}

/**
 * proc 级 kill+等退出+SIGKILL 升级（自 killAwaitEscalating 抽出为模块级：
 * 握手超时路径同用）。exit promise 由调用方供给——当值 child 用 ActiveChild.exited；
 * 握手超时的未就绪 child 现挂 once('exit')。时序：kill 后等 killWaitMs，仍活且 pid 在手
 * 升级 SIGKILL，再等一轮 killWaitMs 作最终兜底。签名带 killWaitMs/logger：模块级函数
 * 不进工厂闭包，两处调用方各传自己的注入值。
 */
export async function killProcAwaitEscalating(
  proc: UtilityProcessLike,
  exited: Promise<void>,
  context: string,
  killWaitMs: number,
  logger: LogLike,
): Promise<void> {
  const didExit = await Promise.race([exited.then(() => true), delay(killWaitMs).then(() => false)])
  if (didExit) return
  // 升级 SIGKILL 前才读 pid（原在入口快照）——killWaitMs（2s）窗内
  // 子进程可能已死亡且 pid 被系统复用，按入口旧 pid 盲杀会误伤无关进程（极窄理论窗）。
  // Electron 语义：UtilityProcess 退出后 pid 置 undefined（注引 electron.d.ts：
  // spawn 前/exit 后为 undefined），重读 undefined = 已退出而 exit 事件竞态迟到 → 不升级，
  // 维持「超时放行」最终兜底；仍为在册 pid 才强杀。残余窗口如实记档：重读到 process.kill
  // 之间仍有微秒级缝隙，彻底闭合需句柄级 kill（utilityProcess 面未暴露），超本修法范畴。
  const pid = proc.pid
  if (pid === undefined) return // 无 pid（未 spawn 成功/窗口内已退出）：维持原「超时放行」口径
  try {
    process.kill(pid, 'SIGKILL')
    logger.warn('server-manager', `${context}：kill 后 ${killWaitMs}ms 仍未退出（SIGTERM 疑似被吞），已升级 SIGKILL 强杀（pid=${pid}）`)
  } catch (e) {
    logger.warn('server-manager', `${context}：SIGKILL 升级失败（child 可能已自行退出）：${errMsg(e)}`)
  }
  await Promise.race([exited, delay(killWaitMs)])
}

/**
 * 每 fork 一轮握手（退避重启的新 child 各发各的 ready，不假设全局一次性）。
 * ready → resolve 端口；boot-error 信封 → ServerBootError；启动途中 exit → 同类错误；
 * 30s 超时兜底（child 挂起）→ kill+等退出+SIGKILL 升级后按启动失败收口。settle 后残余
 * 监听挂在 child 对象上随其消亡，无跨 child 泄漏（exit persistent 版本由 start 成功路径另挂）。
 * kill 等待改经 killWaitMs 参数注入（缺省 = 模块常量，生产行为
 * 不变）——超时 kill 链此前直用 KILL_WAIT_TIMEOUT_MS 字面量，测试注入 deps.killWaitMs
 * 缩短等待的口径在握手超时路径不完备（kill 升级段仍按 2s 常量等，注入口径名存实亡）。
 * launch 由工厂闭包调本函数，注入值随闭包 killWaitMs 透传。
 */
export function handshake(
  proc: UtilityProcessLike,
  logger: LogLike,
  killWaitMs: number = KILL_WAIT_TIMEOUT_MS,
): Promise<number> {
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
          // kill 不再 fire-and-forget—— 已实证 SIGTERM 可被吞，
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
            killWaitMs,
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
        // （修复批）：boot-error 分支此前 settle 即 reject、无 kill 兜底——
        // child 发完 boot-error 预期自退，但自退挂住（exit 被吞/清理逻辑没兜住）时无人
        // 接管，滞留占端口/成孤儿直至 app 退出（超时分支同族纪律本节漏网）。
        // 对齐超时分支：boot-error 后等退出（短窗），未退则 kill + SIGKILL 升级收口；
        // 正常自退路径 exited 立即 resolve，kill 链零打扰。killWaitMs 随注入透传（与
        // 超时分支同口径，测试可缩短等待）。
        const exited = new Promise<void>((resolveExit) => proc.once('exit', () => resolveExit()))
        void killProcAwaitEscalating(proc, exited, 'studio server boot-error 后未自退', killWaitMs, logger).catch(
          () => {},
        )
      }
    })
    proc.once('exit', (code: number) =>
      settle(() => rejectRaw(new ServerBootError('EXIT', `studio server 子进程启动途中退出（exit code ${code}）`))),
    )
    // fork/spawn 失败或异常终止（V8 FatalError）经 'error' 事件到达——
    // 此前 handshake 只认 message/exit/超时三路，error 形态要么挂满 30s 超时收场、要么
    // （无任何监听时）直接崩主进程。此处快失败（report 进 reject 文案），诊断由
    // startProc 的持久监听全文留痕。
    proc.on('error', (type: string, location: string, report: string) =>
      settle(() =>
        rejectRaw(
          new ServerBootError(
            'FORK_ERROR',
            `studio server utilityProcess 异常（error 事件：${type}${location ? ` @ ${location}` : ''}）：${report.slice(0, 400)}`,
          ),
        ),
      ),
    )
  })
}
