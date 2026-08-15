/**
 * B4（DSH-9）：重试策略纯函数——退避公式 / 对称抖动 / Retry-After 封顶 / 可重试判据。
 */
import { test, expect } from 'vitest'
import { DEFAULT_RETRY_POLICY, backoffDelayMs, shouldRetryError } from '../../src/ai/retry-policy.js'
import { GenError } from '../../src/ai/gen.js'

const policy = DEFAULT_RETRY_POLICY

test('backoffDelayMs: 指数退避序列（rng=0.5 → jitter=1，确定性）', () => {
  const rng = () => 0.5
  expect(backoffDelayMs(policy, 1, { rng })).toBe(1000)
  expect(backoffDelayMs(policy, 2, { rng })).toBe(2000)
  expect(backoffDelayMs(policy, 3, { rng })).toBe(4000)
  expect(backoffDelayMs(policy, 4, { rng })).toBe(8000)
})

test('backoffDelayMs: 对称抖动 ±20%（rng=0 → 0.8x；rng=1 → 1.2x）', () => {
  expect(backoffDelayMs(policy, 1, { rng: () => 0 })).toBe(800)
  expect(backoffDelayMs(policy, 1, { rng: () => 1 })).toBe(1200)
})

test('backoffDelayMs: 封顶 maxDelayMs（指数段超顶/抖动上浮都夹住）', () => {
  expect(backoffDelayMs(policy, 20, { rng: () => 0.5 })).toBe(30_000)
  expect(backoffDelayMs(policy, 20, { rng: () => 1 })).toBe(30_000)
})

test('backoffDelayMs: 服务端 Retry-After 优先且封顶——超顶返回 null（不重试）', () => {
  expect(backoffDelayMs(policy, 1, { providerRetryAfterMs: 5000 })).toBe(5000)
  expect(backoffDelayMs(policy, 1, { providerRetryAfterMs: 0 })).toBe(0)
  expect(backoffDelayMs(policy, 1, { providerRetryAfterMs: 60_000 })).toBeNull()
  expect(backoffDelayMs(policy, 1, { providerRetryAfterMs: policy.maxDelayMs })).toBe(policy.maxDelayMs)
})

test('shouldRetryError: code 命中优先（RATE_LIMIT/5xx/超时/网络）；他码不重试', () => {
  expect(shouldRetryError(policy, new GenError('429', true, { code: 'RATE_LIMIT' }))).toBe(true)
  expect(shouldRetryError(policy, new GenError('5xx', true, { code: 'SERVER_ERROR' }))).toBe(true)
  expect(shouldRetryError(policy, new GenError('timeout', true, { code: 'TIMEOUT' }))).toBe(true)
  expect(shouldRetryError(policy, new GenError('conn', false, { code: 'NETWORK' }))).toBe(true)
  expect(shouldRetryError(policy, new GenError('auth', false, { code: 'AUTH' }))).toBe(false)
  expect(shouldRetryError(policy, new GenError('window', false, { code: 'CONTEXT_WINDOW_EXCEEDED' }))).toBe(false)
})

test('shouldRetryError: 无 code 按布尔 retryable 兜底（mode:always——存量口径不变）', () => {
  expect(shouldRetryError(policy, new GenError('legacy retryable', true))).toBe(true)
  expect(shouldRetryError(policy, new GenError('legacy fatal', false))).toBe(false)
})
