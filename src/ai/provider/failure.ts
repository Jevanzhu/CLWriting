/**
 * HTTP 错误 → 结构化错误码映射 + 失败处置决策表（LlmFailure 对标）。
 *
 * 三个适配器的 toErrorEvent 统一走这里；runner 重试按 failureAction 的结果决定动作
 * （retry-policy.shouldRetryError 消费 'retry' 族——单口径化后的唯一事实源），
 * 不再对 message 字符串做模式匹配。
 *
 * 两个动作的消费者范围同界（都在 chat 编排层最小接线，其余路径照旧终态）：
 * - shrink-prompt：超窗 400 后收缩历史重试恰一次（orchestrate/chat/turns.ts 主模型发送处）；
 * - switch-provider：首发命中换网族（AUTH/NOT_FOUND/UNSUPPORTED）且存在备用供应商时，
 *   换网重发恰一次（同 turns-phases.ts retryWithAlternateProvider）。非 chat 路径
 *   （self-heal/spawn/rewrite 等）拿到这两个动作仍按终态处理。
 */

import type { GenErrorCode } from './types.js'

/** HTTP status + 错误消息 → 错误码（消息启发只用于 400 的超窗识别） */
export function httpStatusToCode(status: number | undefined, message: string): GenErrorCode {
  if (status === 429) return 'RATE_LIMIT'
  // 408 Request Timeout 命名码 TIMEOUT（复用既有码，无新成员）——
  // 此前落 UNKNOWN，failureAction 走 default 终态化 author，请求超时这类瞬时故障
  // 不进重试族（网关侧短暂拥塞即停机，重试即可自愈的面被放大成人工介入）
  if (status === 408) return 'TIMEOUT'
  if (status === 401 || status === 402 || status === 403) return 'AUTH'
  if (status === 404) return 'NOT_FOUND'
  if (status !== undefined && status >= 500) return 'SERVER_ERROR'
  if (status === 400) {
    // 超窗各家文案不一：Anthropic "prompt is too long"、OpenAI "context_length_exceeded"、
    // DeepSeek "maximum context length"——统一归 CONTEXT_WINDOW_EXCEEDED（改提示词信号）
    // 正则收紧为短语级——此前裸 "context" 一词命中会把
    // 「invalid context id」「context is required」等无关 400 误归超窗（shrink-prompt 信号失真）
    // 同款收紧补漏——裸备选 "too long" 会把 "stop sequence too
    // long"/"name too long" 等请求组装类 400 误归超窗（接线自动缩输入后将错触发
    // 缩窗）；收敛为 prompt/input too long 级短语
    if (
      /context.{0,24}(length|exceed|too long|window|limit)|prompt is too long|input too long|token.{0,24}(limit|maximum|exceed)/i.test(
        message,
      )
    ) {
      return 'CONTEXT_WINDOW_EXCEEDED'
    }
    return 'BAD_REQUEST'
  }
  return 'UNKNOWN'
}

/**
 * Retry-After 头 → 毫秒。支持秒数与 HTTP-date 两种格式；解析不了返回 undefined（不猜）。
 * 不做封顶/重试决策——尊重与否属退避升级的策略层。
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
  const requestId = headerValue(headers, 'x-request-id') ?? headerValue(headers, 'request-id')
  return {
    ...(retryAfter !== undefined ? { retryAfterMs: retryAfter } : {}),
    ...(requestId !== undefined && requestId !== '' ? { requestId } : {}),
  }
}

/** 失败处置动作（决策表输出） */
type FailureAction =
  | 'retry' // 同 provider 退避重试（落地抖动公式）
  | 'switch-provider' // 换 provider/模型（凭据/配额/能力问题，重试无意义）
  | 'shrink-prompt' // 缩输入（超窗 →压缩/裁剪触发信号）
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
    case 'AUTH':
    case 'NOT_FOUND':
    case 'UNSUPPORTED':
      // 消费者 = chat 编排层（turns-phases.ts retryWithAlternateProvider：首发命中本族
      // 且有备用供应商配置时换网重发恰一次，见 test/ai/chat-switch-provider.test.ts）。
      // runner 自身不做换网：非 chat 路径拿到本动作仍按终态处理（与下方 shrink-prompt 同界）。
      return 'switch-provider'
    case 'CONTEXT_WINDOW_EXCEEDED':
      // 消费者 = chat 编排层超窗收缩重试（同上）；runner 本身无收缩行为，非 chat 路径照旧终态
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
