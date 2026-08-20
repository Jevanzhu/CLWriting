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
 * - fail-open：单条落盘失败（磁盘满/目录被删）只降级 console.error 该条，不抛出、
 *   不熔断后续写入——诊断通道不允许成为新故障源；
 * - 镜像开关由入口决定：dev / CLI / 测试镜像 console（看得见），Electron 打包态
 *   console 输出到无人看见的地方，关镜像只落文件。
 */
import { appendFile, mkdir, readdir, unlink } from 'node:fs/promises'
import { join } from 'node:path'

export type LogLevel = 'error' | 'warn' | 'info'

/** 保留天数：超过 7 天的 app-YYYYMMDD.jsonl 在 initLogging 时清理（best-effort）。 */
const RETENTION_DAYS = 7

interface LogState {
  /** 落盘目录；null = 未初始化（仅 console 镜像）。initLogging(null) 显式关落盘。 */
  logsDir: string | null
  /** 是否同时镜像 console（dev/CLI 态 true；打包态 false——console 无人看见）。 */
  mirrorConsole: boolean
  /** 串行写队列尾：每条日志链在上一条之后，行序 = 调用序。 */
  tail: Promise<void>
}

let state: LogState = { logsDir: null, mirrorConsole: true, tail: Promise.resolve() }

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
 */
export function initLogging(opts: { logsDir: string | null; mirrorConsole?: boolean }): void {
  state = {
    logsDir: opts.logsDir,
    mirrorConsole: opts.mirrorConsole ?? true,
    // 保留既有队列尾：init 前已排队的行仍按序落完，不会因换目录丢行
    tail: state.tail,
  }
  if (opts.logsDir) {
    // 队列化：目录创建与清理也排在既有写之后，避免与在途 appendFile 竞态
    state.tail = state.tail
      .then(() => mkdir(opts.logsDir!, { recursive: true }))
      .then(() => cleanupOldLogs(opts.logsDir!))
      .catch(() => {})
  }
}

/** 单条日志：序列化 → 排队落盘（失败降级 console）→ 可选镜像。永不抛出。 */
function emit(level: LogLevel, tag: string, msg: string, err?: unknown): void {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    tag,
    msg,
    ...(err === undefined ? {} : { err: serializeErr(err) }),
  })
  const mirror = () => {
    if (!state.mirrorConsole) return
    if (level === 'error') console.error(`[${tag}] ${msg}`, ...(err === undefined ? [] : [err]))
    else if (level === 'warn') console.warn(`[${tag}] ${msg}`, ...(err === undefined ? [] : [err]))
    else console.log(`[${tag}] ${msg}`)
  }
  mirror()
  if (!state.logsDir) return
  const file = dayFile(state.logsDir)
  state.tail = state.tail
    .then(() => appendFile(file, line + '\n', 'utf8'))
    .catch(() => {
      // fail-open：落盘失败（磁盘满/目录被删）降级 console 保这条留痕可见；
      // 队列继续（catch 已吞），后续写入照常尝试
      console.error(`[log] 落盘失败，降级 console：${line}`)
    })
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
  state = { logsDir: null, mirrorConsole: true, tail: Promise.resolve() }
}

/** 测试钩子：等待串行队列排空（断言文件内容前调用）。 */
export async function flushLogsForTest(): Promise<void> {
  await state.tail
}
