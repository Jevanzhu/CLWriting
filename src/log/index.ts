/**
 * 结构化日志通道（迭代方向 A4 / 批 0）。
 *
 * 边界（与事件库的分工）：进程诊断归本模块（JSONL 按天落盘、7 天轮转），
 * 业务观测归事件库（append-only SQLite）——两条通道不合并：事件库是产品数据，
 * 日志是运维数据，保留策略不同。
 *
 * 语义：
 * - 未 initLogging 前（单测直调内核 / 独立脚本）：仅镜像 console——与引入本模块前
 *   的行为逐字节等价，存量测试零感知；
 * - initLogging 后：{ts, level, tag, msg, err?} 逐行 JSONL 追加到
 *   <logsDir>/app-YYYYMMDD.jsonl（本地日期），进程内串行队列保证行序与调用序一致，
 *   调用方永不 await（诊断留痕不允许成为请求路径上的新阻塞源）；
 * - stdout-only 模式（阶段 22 批 U2 / U-5 单写者，S-3 + 二轮 F-4）：env
 *   CLW_LOG_STDOUT=1 时 initLogging 层短路——不设 logsDir、不 mkdir、不跑 7 天清理，
 *   emit 直写 process.stdout 一行与落盘行同构的 JSON（child 进程专用：server-manager
 *   fork 时经 options.env 注入，main 以 stdio:pipe 收行解析重发落盘——单写者，双进程
 *   不再同写同一 logs 目录/双清同一轮转）；短路必须在本函数（startServer 内部会再
 *   init 一次，入口层挡不住）；
 * - fail-open：单条落盘失败（磁盘满/目录被删）只降级 console.error 该条，不抛出、
 *   不熔断后续写入——诊断通道不允许成为新故障源；
 * - 内存闸（2026-08-24 审计 D2）：落盘队列背压上限——磁盘挂起（appendFile 长期
 *   pending）时待写行不再无界累积（原 tail 链每条日志链一个闭包，慢盘下闭包线性
 *   增长）；超限丢最旧 + 周期性 warn 计数（慢盘场景内存有界优先于日志完备）；
 * - 镜像开关由入口决定：dev / CLI / 测试镜像 console（看得见），Electron 打包态
 *   console 输出到无人看见的地方，关镜像只落文件。
 */
import { appendFile, mkdir, readdir, unlink } from 'node:fs/promises'
import { join } from 'node:path'

export type LogLevel = 'error' | 'warn' | 'info'

/** 保留天数：超过 7 天的 app-YYYYMMDD.jsonl 在 initLogging 时清理（best-effort）。 */
const RETENTION_DAYS = 7

/** 内存闸（2026-08-24 审计 D2）：待写队列上限——磁盘挂起时待写行数封顶于此，
 *  超限丢最旧（慢盘场景内存有界优先于日志完备） */
export const MAX_PENDING_WRITES = 1024
/** D2：背压告警的周期（同一条 warn 两次出现的最小间隔；首次丢弃立即告警） */
const BACKPRESSURE_WARN_INTERVAL_MS = 10_000

interface LogState {
  /** 落盘目录；null = 未初始化（仅 console 镜像）。initLogging(null) 显式关落盘。 */
  logsDir: string | null
  /** 是否同时镜像 console（dev/CLI 态 true；打包态 false——console 无人看见）。 */
  mirrorConsole: boolean
  /** stdout-only 模式（CLW_LOG_STDOUT=1）：emit 直写 stdout JSON 行，不落盘不镜像 */
  stdoutOnly: boolean
  /** 串行写队列尾：当前泵（或 init 的 mkdir/清理链）收口 promise——flush 钩子据此等待。 */
  tail: Promise<void>
  /** D2：待写行队列（泵串行 shift 落盘；超 MAX_PENDING_WRITES 丢最旧） */
  pending: string[]
  /** D2：泵在途标记（在途时新入队行由既有泵继续收，不另起泵） */
  pumping: boolean
  /** D2：累计丢弃行数（周期性 warn 计数用） */
  droppedCount: number
  /** D2：上次背压告警时间（限频） */
  lastDropWarnAt: number
}

let state: LogState = {
  logsDir: null,
  mirrorConsole: true,
  stdoutOnly: false,
  tail: Promise.resolve(),
  pending: [],
  pumping: false,
  droppedCount: 0,
  lastDropWarnAt: 0,
}

/** 错误对象 → 可 JSON 行序列化形状；非 Error 值收编为 message 字符串。 */
function serializeErr(err: unknown): { name: string; message: string; stack?: string } {
  if (err instanceof Error) {
    return { name: err.name, message: err.message, stack: err.stack }
  }
  return { name: typeof err, message: String(err) }
}

/** 本地日期文件名段：app-YYYYMMDD.jsonl（按本地时区轮转，与「按天」直觉一致）。 */
function dayFile(logsDir: string, d = new Date()): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return join(logsDir, `app-${y}${m}${day}.jsonl`)
}

/** 本地日期 key（YYYY-MM-DD）。M2（二轮复审）：成本/trace 按日分桶统一走本地日——
 * 此前用 UTC ISO 切日，东八区 0-8 点的调用记到前一 UTC 日，与日志文件日（本地日）、
 * 用户「今天」直觉三者错位。 */
export function localDayKey(t: number | string | Date): string {
  const d = t instanceof Date ? t : new Date(t)
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/** 解析 app-YYYYMMDD.jsonl 文件名日期；不匹配返回 null。 */
function parseDay(name: string): Date | null {
  const m = /^app-(\d{4})(\d{2})(\d{2})\.jsonl$/.exec(name)
  if (!m) return null
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
  return Number(m[1]) === d.getFullYear() && Number(m[2]) - 1 === d.getMonth() && Number(m[3]) === d.getDate()
    ? d
    : null
}

/** 清理超过保留期的日志文件。best-effort：单文件删除失败仅忽略（下次启动再试）。 */
async function cleanupOldLogs(logsDir: string): Promise<void> {
  try {
    const names = await readdir(logsDir)
    const cutoff = Date.now() - RETENTION_DAYS * 24 * 3600 * 1000
    await Promise.all(
      names
        .map((n) => ({ n, d: parseDay(n) }))
        .filter((x): x is { n: string; d: Date } => x.d !== null && x.d.getTime() < cutoff)
        .map((x) => unlink(join(logsDir, x.n)).catch(() => {})),
    )
  } catch {
    /* 目录不存在 / 不可读：无事可清 */
  }
}

/**
 * 初始化日志落盘。幂等：可重复调用（desktop main 早期 init 一次、startServer 再对齐一次）。
 * logsDir 传 null = 显式只镜像不落盘。轮转清理由本调用触发（启动期一次，不在写路径上做）。
 * stdout-only（CLW_LOG_STDOUT=1）：本层短路——opts 全部忽略，不设 logsDir/不 mkdir/
 * 不 cleanup（child 每次 fork 不再有文件系统副作用、不与 main 双清同一 logs 目录），
 * 后续 emit 直写 stdout。
 */
export function initLogging(opts: { logsDir: string | null; mirrorConsole?: boolean }): void {
  if (process.env['CLW_LOG_STDOUT'] === '1') {
    state = {
      logsDir: null,
      mirrorConsole: false,
      stdoutOnly: true,
      // 保留既有队列尾：init 前已排队的行仍按序处理完（stdout 模式下立即走新通道）
      tail: state.tail,
      // D2：待写队列/泵/计数在 init 换态时原样接力（在途泵闭包读模块级 state，
      // 数组引用不换则无缝续排）
      pending: state.pending,
      pumping: state.pumping,
      droppedCount: state.droppedCount,
      lastDropWarnAt: state.lastDropWarnAt,
    }
    return
  }
  state = {
    logsDir: opts.logsDir,
    mirrorConsole: opts.mirrorConsole ?? true,
    stdoutOnly: false,
    // 保留既有队列尾：init 前已排队的行仍按序落完，不会因换目录丢行
    tail: state.tail,
    pending: state.pending,
    pumping: state.pumping,
    droppedCount: state.droppedCount,
    lastDropWarnAt: state.lastDropWarnAt,
  }
  if (opts.logsDir) {
    // 队列化：目录创建与清理也排在既有写之后，避免与在途 appendFile 竞态
    state.tail = state.tail
      .then(() => mkdir(opts.logsDir!, { recursive: true }))
      .then(() => cleanupOldLogs(opts.logsDir!))
      .catch(() => {})
  }
}

/** R72-9（二十轮 C-10）：兜底脱敏——常见 API key 形态掩码（sk- 前缀 / Bearer 头）。
 *  纵深一层：现状防线靠调用方「不把密钥记进日志」的纪律，此处兜底层不替代纪律，
 *  只收 1 命中即 8+ 字符的常见形态（不含 sk- 短前缀普通词，误伤面极小）。 */
const KEY_MASK_RE = /(sk-[A-Za-z0-9_-]{8,}|Bearer\s+[A-Za-z0-9._-]{8,})/g
/**
 * R72-9 引入、R26-95（二十六轮）修正：key 掩码。Bearer 形态改为「token 部分掩码」——
 * 原实现 m.slice(0,5) 对 Bearer 产出「Beare***」破损外观（前缀被截断、token 一位未掩），
 * 现保留 Bearer 前缀 + 全掩 + 末 4 位（末 4 位足够人工对账定位，不构成可用凭据）；
 * sk- 形态维持原口径（保留前 5 字符 + ***）。导出供直测（掩码是安全语义，锁形貌）。
 */
export function maskKeys(s: string): string {
  return s.replace(KEY_MASK_RE, (m) => {
    const wsAt = m.search(/\s/)
    if (wsAt === -1) return m.slice(0, 5) + '***' // sk- 形态：无空白分隔，原口径
    const token = m.slice(wsAt).trim()
    return `Bearer ****${token.slice(-4)}`
  })
}

/** R76-30：镜像面 err 掩码——Error 实例重建（message/stack 过 KEY_MASK_RE，name
 *  原样）保住 instanceof 契约；非 Error 原样交 console 渲染（掩码只兜字符串面）。 */
function maskedErr(e: unknown): unknown {
  if (!(e instanceof Error)) return e
  const m = new Error(maskKeys(e.message))
  m.name = e.name
  if (e.stack) m.stack = maskKeys(e.stack)
  return m
}

/** 单条日志：序列化 → 排队落盘（失败降级 console）→ 可选镜像。永不抛出。 */
function emit(level: LogLevel, tag: string, msg: string, err?: unknown): void {
  let line: string
  try {
    line = JSON.stringify({
      ts: new Date().toISOString(),
      level,
      tag,
      msg,
      ...(err === undefined ? {} : { err: serializeErr(err) }),
    })
  } catch {
    // R72-9（二十轮 C-10）：序列化失败兜底（病态 err 形态逃过 serializeErr 面）——
    // 降级为纯文本行，「永不抛出」契约不破
    line = JSON.stringify({ ts: new Date().toISOString(), level, tag, msg, err: '[[unserializable]]' })
  }
  // R72-9（二十轮 C-10）：key 掩码在序列化后的 JSON 行上做（msg 与 err.message/stack
  // 一层兜底；JSON 文本层替换不影响行结构）
  line = maskKeys(line)
  if (state.stdoutOnly) {
    // child 专用通道：一行 JSON 直写 stdout（与落盘行同构），main 收行解析重发落盘。
    // 不镜像 console（stdout 本身就是出口，镜像即双写）。
    try {
      process.stdout.write(line + '\n')
    } catch {
      /* stdout 已关闭（进程收尾期）：fail-open */
    }
    return
  }
  const mirror = () => {
    if (!state.mirrorConsole) return
    // R76-30（二十四轮 D 域）：console 镜像出口同步过 maskKeys——此前掩码只做在
    // 落盘/child stdout 的 JSON 行上，镜像走原始 msg/err，同一日志两个出口密钥
    // 一掩一裸（终端/IDE 控制台恰是人最常盯的出口）。err 保持 Error 实例形态
    //（Z-P2-9 契约：镜像 err 须 instanceof Error 且 message 含原始异常摘要），
    // message/stack 内容过掩码，name 原样。
    if (level === 'error') console.error(`[${tag}] ${maskKeys(msg)}`, ...(err === undefined ? [] : [maskedErr(err)]))
    else if (level === 'warn') console.warn(`[${tag}] ${maskKeys(msg)}`, ...(err === undefined ? [] : [maskedErr(err)]))
    else console.log(`[${tag}] ${maskKeys(msg)}`)
  }
  mirror()
  if (!state.logsDir) return
  enqueueWrite(line)
}

/** 入队待写（D2 改造：显式有界队列 + 单泵串行排空，替代原先「每条日志链一个闭包
 *  到 tail」的无界链）——行序 = 入队序 = 调用序（与原 tail 链同语义）。
 *  内存闸（2026-08-24 审计 D2）：磁盘挂起时待写闭包不再无界累积，超限丢最旧。 */
function enqueueWrite(line: string): void {
  if (state.pending.length >= MAX_PENDING_WRITES) {
    // 丢最旧腾位（pending 只含未落盘行，队头即最旧待写）
    state.pending.shift()
    state.droppedCount++
    // 周期性 warn 计数：直接 console.error（不经 emit——那会回灌本队列）；与
    // fail-open 降级同口径，不镜像开关不挡运维可见性
    if (Date.now() - state.lastDropWarnAt >= BACKPRESSURE_WARN_INTERVAL_MS) {
      state.lastDropWarnAt = Date.now()
      console.error(
        `[log] 待写队列超限（${MAX_PENDING_WRITES} 条）：磁盘写入挂起或过慢，已丢弃最旧待写行（累计 ${state.droppedCount} 条）——内存有界优先于日志完备`,
      )
    }
  }
  state.pending.push(line)
  if (!state.pumping) {
    state.pumping = true
    // 泵链在当前 tail 之后（含 init 排队的 mkdir/清理），串行落盘；在途时新入队行
    // 由本泵 while 继续收，不另起泵
    state.tail = state.tail.then(async () => {
      try {
        // D2 实施期定谳（startup-notices 全量红回归）：泵可能先于「新目录的 mkdir 链」
        // 执行——emit → initLogging(新目录) 同步序列会把本泵排在新 mkdir 之前；或前
        // 一轮泵在途时新行入队 + 换目录 init，在途泵继续排空时 state.logsDir 已指向
        // 新目录（mkdir 排在本泵之后）→ appendFile ENOENT 降级丢行。泵首幂等 mkdir
        // （recursive，已存在时一次廉价 stat 直过）兜底两类交错；init 的 mkdir 链保留。
        if (state.logsDir) await mkdir(state.logsDir, { recursive: true }).catch(() => {})
        while (state.pending.length) {
          const pending = state.pending.shift()!
          try {
            // 第九轮 L-6：日期文件在 flush 时重取——入队时取会在跨本地零点排队时把
            // 日志行写进前一天的文件（轮转边界错位）
            await appendFile(dayFile(state.logsDir!), pending + '\n', 'utf8')
          } catch {
            // fail-open：落盘失败（磁盘满/目录被删）降级 console 保这条留痕可见；
            // 泵继续（catch 已吞），后续写入照常尝试
            console.error(`[log] 落盘失败，降级 console：${pending}`)
          }
        }
      } finally {
        state.pumping = false
      }
    })
  }
}

export const log = {
  error(tag: string, msg: string, err?: unknown): void {
    emit('error', tag, msg, err)
  },
  warn(tag: string, msg: string, err?: unknown): void {
    emit('warn', tag, msg, err)
  },
  info(tag: string, msg: string): void {
    emit('info', tag, msg)
  },
}

/** 测试钩子：重置为未初始化态（vitest 模块隔离下按需使用）。 */
export function resetLoggingForTest(): void {
  state = {
    logsDir: null,
    mirrorConsole: true,
    stdoutOnly: false,
    tail: Promise.resolve(),
    pending: [],
    pumping: false,
    droppedCount: 0,
    lastDropWarnAt: 0,
  }
}

/** 测试钩子：等待串行队列排空（断言文件内容前调用）。 */
export async function flushLogsForTest(): Promise<void> {
  await state.tail
}

/** 测试钩子（D2）：待写队列长度与累计丢写数——背压行为可观测（封顶/丢最旧断言面）。 */
export function debugLogQueueForTest(): { pending: number; dropped: number } {
  return { pending: state.pending.length, dropped: state.droppedCount }
}
