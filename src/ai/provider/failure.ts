/**
 * HTTP 错误 → 结构化错误码映射 + 失败处置决策表（批次 A5 / DSH-15 LlmFailure 对标）。
 *
 * 三个适配器的 toErrorEvent 统一走这里；runner 重试按 failureAction 的结果决定动作
 * （retry-policy.shouldRetryError 消费 'retry' 族——Z-P2-2 单口径化后的唯一事实源），
 * 不再对 message 字符串做模式匹配。switch-provider/shrink-prompt 族留给自愈分流（A7+）。
 */

import type { GenErrorCode } from './types.js'

/** HTTP status + 错误消息 → 错误码（消息启发只用于 400 的超窗识别） */
export function httpStatusToCode(status: number | undefined, message: string): GenErrorCode {
  if (status === 429) return 'RATE_LIMIT'
  // R27-6（二十七轮）：408 Request Timeout 命名码 TIMEOUT（复用既有码，无新成员）——
  // 此前落 UNKNOWN，failureAction 走 default 终态化 author，请求超时这类瞬时故障
  // 不进重试族（网关侧短暂拥塞即停机，重试即可自愈的面被放大成人工介入）
  if (status === 408) return 'TIMEOUT'
  if (status === 401 || status === 402 || status === 403) return 'AUTH'
  if (status === 404) return 'NOT_FOUND'
  if (status !== undefined && status >= 500) return 'SERVER_ERROR'
  if (status === 400) {
    // 超窗各家文案不一：Anthropic "prompt is too long"、OpenAI "context_length_exceeded"、
    // DeepSeek "maximum context length"——统一归 CONTEXT_WINDOW_EXCEEDED（改提示词信号）
    // R42-25（四十二轮）：正则收紧为短语级——此前裸 "context" 一词命中会把
    // 「invalid context id」「context is required」等无关 400 误归超窗（shrink-prompt 信号失真）
    if (/context.{0,24}(length|exceed|too long|window|limit)|prompt is too long|too long|token.{0,24}(limit|maximum|exceed)/i.test(message)) {
      return 'CONTEXT_WINDOW_EXCEEDED'
    }
    return 'BAD_REQUEST'
  }
  return 'UNKNOWN'
}

/**
 * Retry-After 头 → 毫秒。支持秒数与 HTTP-date 两种格式；解析不了返回 undefined（不猜）。
 * 不做封顶/重试决策——尊重与否属 B4 退避升级的策略层。
 */
export function parseRetryAfterMs(v: string | undefined): number | undefined {
  if (!v) return undefined
  const sec = Number(v.trim())
  if (Number.isFinite(sec) && sec >= 0) return Math.round(sec * 1000)
  const at = Date.parse(v)
  if (Number.isFinite(at)) return Math.max(at - Date.now(), 0)
  return undefined
}

/** 从响应头取字段（兼容 Headers 实例与 plain object；键名大小写不敏感） */
function headerValue(headers: unknown, name: string): string | undefined {
  if (!headers) return undefined
  const lower = name.toLowerCase()
  if (typeof (headers as { get?: unknown }).get === 'function') {
    const v = (headers as { get: (k: string) => unknown }).get(lower)
    if (typeof v === 'string') return v
  }
  for (const [k, v] of Object.entries(headers as Record<string, unknown>)) {
    if (k.toLowerCase() === lower && typeof v === 'string') return v
  }
  return undefined
}

/** SDK 错误的 headers → {retryAfterMs?, requestId?}（展开进 error 事件用） */
export function headerErrorFields(headers: unknown): { retryAfterMs?: number; requestId?: string } {
  const retryAfter = parseRetryAfterMs(headerValue(headers, 'retry-after'))
  const requestId =
    headerValue(headers, 'x-request-id') ?? headerValue(headers, 'request-id')
  return {
    ...(retryAfter !== undefined ? { retryAfterMs: retryAfter } : {}),
    ...(requestId !== undefined && requestId !== '' ? { requestId } : {}),
  }
}

/** 失败处置动作（决策表输出） */
export type FailureAction =
  | 'retry' // 同 provider 退避重试（B4 落地抖动公式）
  | 'switch-provider' // 换 provider/模型（凭据/配额/能力问题，重试无意义）
  | 'shrink-prompt' // 缩输入（超窗 → B1 压缩/裁剪触发信号）
  | 'author' // 交作者决策（请求组装/协议问题，自动路径到头）
  | 'none' // 非失败（主动中断）

/** 决策表：错误码 → 处置动作。无 code 时退回布尔 retryable（存量路径口径）。 */
export function failureAction(e: { code?: GenErrorCode; retryable?: boolean }): FailureAction {
  switch (e.code) {
    case 'RATE_LIMIT':
    case 'SERVER_ERROR':
    case 'TIMEOUT':
    case 'NETWORK':
      return 'retry'
    // R66-11（十四轮）：switch-provider / shrink-prompt 在 A7 接线前无消费者——调用侧
    // 拿到这两个动作的实际处理与终态（author）等同：配额/凭据错不会自动换供应商、超窗
    // 不会自动缩输入。决策表保留动作语义供 A7 落地；勿据返回值断言存在自动降级行为
    case 'AUTH':
    case 'NOT_FOUND':
    case 'UNSUPPORTED':
      return 'switch-provider'
    case 'CONTEXT_WINDOW_EXCEEDED':
      return 'shrink-prompt'
    case 'ABORTED':
      return 'none'
    case 'MAX_TOKENS':
    case 'BAD_REQUEST':
    case 'PROTOCOL':
    case 'UNKNOWN':
    default:
      return e.retryable ? 'retry' : 'author'
  }
}
