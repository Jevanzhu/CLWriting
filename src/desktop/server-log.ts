/**
 * studio server 子进程 stdio 日志转发缝 —— 自 src/desktop/server-manager.ts 拆出。
 *
 * R0916-5g（2026-09-16，⑤④产品巨件拆分波3）：server-manager.ts（1127 行）两缝
 * 纯移动拆分（零行为变化、零逻辑改写，代码与历史注释原样随迁）。本文件承载服务端
 * 日志转发族（§3.5 单写者的 main 侧半边）：child stdout/stderr → main logger 转发
 * forwardChildStdio、行切分 splitLines（LineSplitter 冲刷句柄 + 单行缓冲内存闸上限
 * MAX_LINE_CHARS——顶层求值常量单源本文件，不经环回 re-export 链被引）、JSON 行按
 * level/tag/err 重发 forwardLogLine、err 字段 Error 重建 reconstructErr。
 * 依赖方向单向（无环回引）：进程/日志通道契约 UtilityProcessLike / LogLike 自
 * server-proc.ts（进程管理缝，两缝共用契约的单源所在）import，本文件不回引残核
 * server-manager.ts（R0916-5f state 拆分同款纪律）。服务器状态机
 * createStudioServerManager（约 620 行，G 普查批不动清单第一项）留
 * server-manager.ts，本批零触碰其函数体；迁出公开导出（MAX_LINE_CHARS /
 * splitLines / forwardLogLine）经 server-manager.ts 逐名 re-export 桥接，全库
 * 消费方 import 面零改动。
 */
import { errMsg } from '../log/index.js'
import type { UtilityProcessLike, LogLike } from './server-proc.js'

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

export function forwardChildStdio(proc: UtilityProcessLike, logger: LogLike): void {
  // 内存闸（2026-08-24 审计 D1）：单行超限强制截断的计数告警（stdout/stderr 同口径）
  const warnForced = (side: 'stdout' | 'stderr') => (count: number) =>
    logger.warn('server-manager', `child ${side} 单行超 ${MAX_LINE_CHARS >> 20}MB 无换行，已强制截断出行（累计 ${count} 次）`)
  // R55-A-2（五十五轮）：流错误留痕——原先空回调零痕迹，child 日志链路断裂（流销毁/
  // 管道错等）不可观测；附 err message（非 Error 形态按 String 兜底，同仓 git/ai-track
  // 重评-15 先例）。不上抛不重试：转发尽力而为语义不变，丢行不丢进程。
  const warnErrored = (side: 'stdout' | 'stderr') => (err: unknown) =>
    logger.warn('server-manager', `child ${side} stdio 流异常，转发中止：${errMsg(err)}`)
  const stdoutSplitter = splitLines(
    proc.stdout,
    (line) => forwardLogLine(line, logger),
    warnForced('stdout'),
    warnErrored('stdout'),
  )
  const stderrSplitter = splitLines(
    proc.stderr,
    (line) => logger.warn('server-proc', line),
    warnForced('stderr'),
    warnErrored('stderr'),
  )
  // R50-A-4（五十轮）：子进程退出时强制冲刷两路切分缓冲的残留半行——崩溃尾行常无
  // 换行（stderr 崩溃堆栈恰是最关键取证线索），原先随进程死亡丢弃。exit 后流不再有
  // data，冲一次即弃（flush 幂等；kill/崩溃/自然退出三路 exit 均经此收口）。
  proc.once('exit', () => {
    stdoutSplitter.flush()
    stderrSplitter.flush()
  })
}

/** （导出供测试直测解析口径）child 输出 → 行切分。
 *  onWarn：每次强制截断出行时回调（入参为累计次数），缺省不告警。
 *  onError：流 'error' 事件回调（R55-A-2（五十五轮）——原先空回调静默吞零留痕），
 *  缺省维持静默吞（不反噬调用方，转发尽力而为语义不变）。
 *  R50-A-4（五十轮）：返回切分器句柄——exit 冲刷接口见 flush()，接线见 forwardChildStdio。 */
interface LineSplitter {
  /** 强制冲刷残留缓冲的半行（无换行尾行）：子进程 exit 路径调用一次，弃缓冲。
   *  幂等（缓冲已空再调无产出）；冲刷后残余 data 到达照常累积（极窄竞态窗，尽力而为）。 */
  flush(): void
}

export function splitLines(
  out: NodeJS.ReadableStream | null | undefined,
  onLine: (line: string) => void,
  onWarn?: (forcedCount: number) => void,
  onError?: (err: unknown) => void,
): LineSplitter {
  // R50-A-4：空流无可冲刷缓冲，返回空句柄保调用方接线统一
  if (!out) return { flush: () => {} }
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
  out.on('error', (err: unknown) => {
    // 流异常不反噬 main：转发尽力而为，丢行不丢进程。
    // R55-A-2（五十五轮）：空吞改留痕——child 日志链路断裂原先零痕迹不可观测；
    // 经 onError（forwardChildStdio 接 logger.warn）补一条，仍不上抛、行为不变
    if (onError) onError(err)
  })
  // R50-A-4（五十轮）：崩溃取证——子进程异常退出时尾行常无换行（最后一条诊断/堆栈
  // 恰卡半行），只挂 'data' 的切分缓冲随进程死亡丢弃。返回 flush 供 exit 处理路径
  // 强制冲一次残留半行再弃（trim 后非空才出行，与正常行口径一致）。
  return {
    flush() {
      const line = buf.trim()
      buf = ''
      if (line) onLine(line)
    },
  }
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
