/**
 * A5（DSH-15）：结构化错误码——status 映射 / Retry-After 解析 / 处置决策表。
 */
import { test, expect } from 'vitest'
import {
  httpStatusToCode,
  parseRetryAfterMs,
  headerErrorFields,
  failureAction,
} from '../../src/ai/provider/failure.js'
import type { GenErrorCode } from '../../src/ai/provider/types.js'

test('httpStatusToCode: 状态码 → 错误码全表', () => {
  const cases: Array<[number | undefined, string, GenErrorCode]> = [
    [429, '', 'RATE_LIMIT'],
    [500, '', 'SERVER_ERROR'],
    [503, '', 'SERVER_ERROR'],
    [401, '', 'AUTH'],
    [402, '', 'AUTH'],
    [403, '', 'AUTH'],
    [404, '', 'NOT_FOUND'],
    [400, '普通参数错误', 'BAD_REQUEST'],
    [400, "This model's maximum context length is 4096 tokens", 'CONTEXT_WINDOW_EXCEEDED'],
    [400, 'prompt is too long: 200000 tokens > 200000 maximum', 'CONTEXT_WINDOW_EXCEEDED'],
    [400, 'context_length_exceeded', 'CONTEXT_WINDOW_EXCEEDED'],
    // R42-25（四十二轮）：正则收紧为短语级——裸 "context" 不再命中，无关 400 不误归超窗
    [400, 'invalid context id', 'BAD_REQUEST'],
    [400, 'context is required', 'BAD_REQUEST'],
    // 短语级正例补充：context window / token limit 变体仍归超窗
    [400, 'request exceeds the context window limit', 'CONTEXT_WINDOW_EXCEEDED'],
    [400, 'maximum token limit reached', 'CONTEXT_WINDOW_EXCEEDED'],
    [undefined, '', 'UNKNOWN'],
  ]
  for (const [status, msg, want] of cases) {
    expect(httpStatusToCode(status, msg)).toBe(want)
  }
})

test('parseRetryAfterMs: 秒数 / HTTP-date / 不可解析', () => {
  expect(parseRetryAfterMs('3')).toBe(3000)
  expect(parseRetryAfterMs(' 2 ')).toBe(2000)
  expect(parseRetryAfterMs('0')).toBe(0)
  const future = new Date(Date.now() + 5000).toUTCString()
  const ms = parseRetryAfterMs(future)
  expect(ms).not.toBeUndefined()
  expect(ms!).toBeGreaterThanOrEqual(4000)
  expect(ms!).toBeLessThanOrEqual(5000)
  // 过去时间 → 0（不猜负等待）
  expect(parseRetryAfterMs(new Date(Date.now() - 5000).toUTCString())).toBe(0)
  expect(parseRetryAfterMs(undefined)).toBeUndefined()
  expect(parseRetryAfterMs('garbage')).toBeUndefined()
})

test('headerErrorFields: Headers 实例与 plain object 都取得到（大小写不敏感）', () => {
  const h = new Headers({ 'retry-after': '7', 'x-request-id': 'req-abc' })
  expect(headerErrorFields(h)).toEqual({ retryAfterMs: 7000, requestId: 'req-abc' })
  const plain = { 'Retry-After': '5', 'request-id': 'req-def' }
  expect(headerErrorFields(plain)).toEqual({ retryAfterMs: 5000, requestId: 'req-def' })
  expect(headerErrorFields(undefined)).toEqual({})
  expect(headerErrorFields({})).toEqual({})
})

test('failureAction: 决策表全表', () => {
  const cases: Array<[GenErrorCode | undefined, boolean | undefined, ReturnType<typeof failureAction>]> = [
    ['RATE_LIMIT', true, 'retry'],
    ['SERVER_ERROR', true, 'retry'],
    ['TIMEOUT', true, 'retry'],
    ['NETWORK', false, 'retry'],
    ['AUTH', false, 'switch-provider'],
    ['NOT_FOUND', false, 'switch-provider'],
    ['UNSUPPORTED', false, 'switch-provider'],
    ['CONTEXT_WINDOW_EXCEEDED', false, 'shrink-prompt'],
    ['ABORTED', false, 'none'],
    ['MAX_TOKENS', false, 'author'],
    ['BAD_REQUEST', false, 'author'],
    ['PROTOCOL', false, 'author'],
    ['UNKNOWN', false, 'author'],
    // 无 code 退回布尔 retryable（存量口径）
    [undefined, true, 'retry'],
    [undefined, false, 'author'],
  ]
  for (const [code, retryable, want] of cases) {
    expect(failureAction({ code, retryable })).toBe(want)
  }
})
