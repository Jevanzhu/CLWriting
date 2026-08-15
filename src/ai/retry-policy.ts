/**
 * 重试策略 + 退避公式（批次 B4 / DSH-9 直抄公式）。
 *
 * - 指数退避：exponent=min(retry-1,1024)；exponential=min(initial*2^exp, max)
 * - 对称抖动：jitter=1-jitterRatio+2*jitterRatio*random()（围绕 1 对称，均值不变）
 * - Retry-After 尊重但封顶：服务端值 > maxDelayMs → 不重试（宁可终态也不盲等超长）
 * - 可重试判据：结构化 code 命中 retryableCodes；无 code 时按布尔 retryable 兜底
 *   （mode:'always'——存量错误路径口径不变）
 *
 * 策略常量集中于此（唯一事实源）；未来 provider 表驱动层需要 per-provider 差异时，
 * 在表上加列覆盖本默认值即可，公式不变。
 */

import type { GenError } from './gen.js'
import type { GenErrorCode } from './provider/types.js'

export interface RetryPolicy {
  /** 最大重试次数（不含首发；与旧 MAX_RETRIES=3 对齐） */
  maxRetries: number
  /** 首次退避基数（ms） */
  initialDelayMs: number
  /** 单次退避上限（ms）——也是 Retry-After 的封顶判据 */
  maxDelayMs: number
  /** 对称抖动幅度（0=不抖；0.2 → ±20%） */
  jitterRatio: number
  /** 可重试错误码（决策表 retry 族） */
  retryableCodes: GenErrorCode[]
  /** 无 code 匹配时的兜底：'always' 按布尔 retryable 重试（存量口径）；'codes' 只认 code */
  mode: 'always' | 'codes'
}

/** 默认策略：429/5xx/超时/网络错误重试 3 次，1s 起步指数退避，30s 封顶，±20% 抖动 */
export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxRetries: 3,
  initialDelayMs: 1000,
  maxDelayMs: 30_000,
  jitterRatio: 0.2,
  retryableCodes: ['RATE_LIMIT', 'SERVER_ERROR', 'TIMEOUT', 'NETWORK'],
  mode: 'always',
}

/**
 * 计算第 retry 次重试（1 起）前的等待毫秒。
 * 返回 null = 不应重试（服务端 Retry-After 超过 maxDelayMs——尊重但封顶，宁可终态）。
 *
 * @param rng 随机源（默认 Math.random；测试注入确定性序列）
 */
export function backoffDelayMs(
  policy: RetryPolicy,
  retry: number,
  opts: { providerRetryAfterMs?: number; rng?: () => number } = {},
): number | null {
  // 服务端明示等待：直接尊重（封顶内不再叠抖动——抖低会违反服务端要求）
  if (opts.providerRetryAfterMs !== undefined) {
    return opts.providerRetryAfterMs > policy.maxDelayMs ? null : opts.providerRetryAfterMs
  }
  const exponent = Math.min(retry - 1, 1024)
  const exponential = Math.min(policy.initialDelayMs * 2 ** exponent, policy.maxDelayMs)
  const random = opts.rng ?? Math.random
  const jitter = 1 - policy.jitterRatio + 2 * policy.jitterRatio * random()
  return Math.min(Math.round(exponential * jitter), policy.maxDelayMs)
}

/** 错误是否按策略重试（code 命中优先；无 code 按 mode 兜底布尔 retryable） */
export function shouldRetryError(policy: RetryPolicy, e: GenError): boolean {
  if (e.code !== undefined) return policy.retryableCodes.includes(e.code)
  return policy.mode === 'always' ? e.retryable : false
}
