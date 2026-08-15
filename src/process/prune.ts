/**
 * 无模型文本修剪器（批次 A3 / DSH-3 直抄，中文阈值调小）。
 *
 * 超阈值纯文本入上下文前的机械压缩：code point 头尾保留 + 中段单 marker。
 * 「先机械后智能」的第一道——零模型、零语义判断。
 *
 * 纪律（照抄 dsh compaction-tool-result-pruner）：
 * - 按 Unicode code point 量文本（Array.from，不劈 surrogate pair）；
 * - marker 只插一次；
 * - 替换必须严格更小（< 阈值且 < 原长），否则 throw——宁错勿损坏；
 * - 阈值内原样返回**原引用**（调用方用 === 判 no-op 跳过下游记账）。
 */

export interface PruneOpts {
  /** 超过该 code point 数才开始修剪（默认 4096；中文信息密度高，比 dsh 的 8192 调小） */
  threshold?: number
  /** 头部保留 code point 数（默认 2048） */
  head?: number
  /** 尾部保留 code point 数（默认 512） */
  tail?: number
}

/** 中段省略标记（B3 spill 落地时在此追加「全文取回」指引） */
export const PRUNE_MARKER = '\n\n[...中段已省略...]\n\n'

/**
 * 修剪文本中段：`头 head 字符 + marker + 尾 tail 字符`。
 * 阈值内（≤ threshold）返回原引用；配置非法或校验不过 throw。
 */
export function pruneTextMiddle(text: string, opts: PruneOpts = {}): string {
  const threshold = opts.threshold ?? 4096
  const head = opts.head ?? 2048
  const tail = opts.tail ?? 512

  // 配置校验在调用期（load 期纪律）：head+tail+marker 必须严格小于 threshold，
  // 否则修剪产物必然超阈值——直接暴露配置错误，不静默产出超限文本
  if (head + tail + Array.from(PRUNE_MARKER).length >= threshold) {
    throw new Error(`prune 配置非法：head(${head})+tail(${tail})+marker ≥ threshold(${threshold})`)
  }

  const chars = Array.from(text)
  const total = chars.length
  if (total <= threshold) return text

  const headEnd = Math.min(total, head)
  const tailStart = Math.max(headEnd, total - tail)
  const out = chars.slice(0, headEnd).join('') + PRUNE_MARKER + chars.slice(tailStart).join('')

  // 防御校验：中段确有省略（marker 恰好一次）且产物严格更小——违反即 bug，不产出
  const markerCount = out.split(PRUNE_MARKER).length - 1
  const outLen = Array.from(out).length
  if (markerCount !== 1 || tailStart <= headEnd || outLen >= total || outLen >= threshold) {
    throw new Error('prune 校验失败：替换未严格变小')
  }
  return out
}
