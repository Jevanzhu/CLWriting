/**
 * 重审-批2-1（2026-09-07 全量代码重审 §四P3/§六批2）：Responses 线 completed 后
 * trailing error/response.failed 忽略。
 *
 * 修复背景：`response.completed` 已 emitDone 后，个别网关仍会在流尾补发 error /
 * response.failed 事件——原实现两分支不查终态，照常 yield 终态失败（PROTOCOL、
 * retryable:false），整回合成功产出被判失败。修复后：terminal 已 'completed' 时
 * 忽略该事件（done 已发、产出保持成功；Anthropic/OpenAI Chat 线无此形态）。
 * 假 client 按脚本吐流（同 responses-encrypted.test.ts 口径）。
 */
import { describe, expect, it } from 'vitest'
import type OpenAI from 'openai'
import { createOpenAIResponsesProvider } from '../../../src/ai/provider/index.js'
import type { GenEvent, GenRequest, ProviderConf } from '../../../src/ai/provider/index.js'

/** Responses 线 conf：gpt-5 走 gpt 族 quirks */
const RCONF = {
  name: 't',
  protocol: 'openai-responses' as const,
  auth: 'bearer' as const,
  baseUrl: 'https://example.local',
  model: 'gpt-5',
  apiKey: 'sk-secret',
  caps: null,
} as ProviderConf

/** 终止事件（带 message 产出项 + usage，满足 R1 判空与 done 契约） */
const COMPLETED = {
  type: 'response.completed',
  response: { output: [{ type: 'message' }], usage: { input_tokens: 1, output_tokens: 1 } },
}

/** 脚本型假 Responses client：create() 按脚本吐流（capture 型，同 w0-serialize 口径） */
function scriptedResponses(events: unknown[]): OpenAI {
  return {
    responses: {
      create: async function* (_params: Record<string, unknown>): AsyncGenerator<unknown> {
        for (const ev of events) yield ev
      },
    },
  } as unknown as OpenAI
}

async function run(req: Omit<GenRequest, 'systemPrompt'> & { systemPrompt?: string }, events: unknown[]) {
  const prov = createOpenAIResponsesProvider(RCONF, scriptedResponses(events))
  const out: GenEvent[] = []
  for await (const ev of prov.stream({ systemPrompt: '', ...req }, new AbortController().signal)) out.push(ev)
  return out
}

describe('重审-批2-1：completed 后 trailing error/response.failed 忽略', () => {
  it('completed → error：无 error yield、产出保持成功（done 收尾且唯一）', async () => {
    const events = await run(
      { messages: [{ role: 'user', content: '继续写' }] },
      [
        { type: 'response.output_text.delta', delta: '正文增量' },
        COMPLETED,
        { type: 'error', message: 'gateway late error' },
      ],
    )
    // 修复前：error 事件照常 yield 终态失败（PROTOCOL、retryable:false），成功回合被判失败
    expect(events.some((e) => e.type === 'error')).toBe(false)
    const dones = events.filter((e) => e.type === 'done')
    expect(dones).toHaveLength(1)
    // 产出保持成功：text 增量与 done 都在，done 是最后一个事件
    expect(events.some((e) => e.type === 'text')).toBe(true)
    expect(events.at(-1)!.type).toBe('done')
  })

  it('completed → response.failed：同款忽略（无 error yield、done 收尾）', async () => {
    const events = await run(
      { messages: [{ role: 'user', content: '继续写' }] },
      [
        { type: 'response.output_text.delta', delta: '正文增量' },
        COMPLETED,
        { type: 'response.failed', response: { error: { message: 'late failure' } } },
      ],
    )
    expect(events.some((e) => e.type === 'error')).toBe(false)
    const dones = events.filter((e) => e.type === 'done')
    expect(dones).toHaveLength(1)
    expect(events.at(-1)!.type).toBe('done')
  })

  it('回归护栏：无 completed 在前的 error 照常终态失败（PROTOCOL、不重试）', async () => {
    const events = await run(
      { messages: [{ role: 'user', content: '继续写' }] },
      [
        { type: 'response.output_text.delta', delta: '半截' },
        { type: 'error', message: 'mid-stream error' },
      ],
    )
    const err = events.find((e) => e.type === 'error') as { code?: string; retryable?: boolean } | undefined
    expect(err).toBeDefined()
    expect(err!.code).toBe('PROTOCOL')
    expect(err!.retryable).toBe(false)
    expect(events.some((e) => e.type === 'done')).toBe(false)
  })
})

/**
 * R0912-3（2026-09-12 全量代码重评修复批 #4）：守卫放宽 terminal!=='none'——
 * incomplete(max_tokens) 已 emitDone 后流尾 failed/error 同款忽略（重审-批2-1 只拦
 * completed 的同型另一半）。修复前：terminal 为 'incomplete' 不命中守卫，流尾
 * failed/error 照常 yield 终态失败，max_tokens 回合被翻转成失败。
 */
describe('R0912-3：incomplete(max_tokens) 后流尾 failed/error 同款忽略', () => {
  /** incomplete(max_output_tokens) 终态（带 usage——收尾入账走真值不走估计） */
  const INCOMPLETE_MAX = {
    type: 'response.incomplete',
    response: {
      output: [{ type: 'message' }],
      usage: { input_tokens: 2, output_tokens: 3 },
      incomplete_details: { reason: 'max_output_tokens' },
    },
  }

  it('incomplete → response.failed：无 error yield，done(max_tokens) 收尾且唯一', async () => {
    const events = await run(
      { messages: [{ role: 'user', content: '继续写' }] },
      [
        { type: 'response.output_text.delta', delta: '正文增量' },
        INCOMPLETE_MAX,
        { type: 'response.failed', response: { error: { message: 'late failure' } } },
      ],
    )
    // 修复前：terminal 为 'incomplete' 不命中守卫，流尾 failed 照常 yield 终态失败翻转回合
    expect(events.some((e) => e.type === 'error')).toBe(false)
    const dones = events.filter((e) => e.type === 'done')
    expect(dones).toHaveLength(1)
    // ① incomplete 正常收尾路径不受影响：usage 真值入账 + max_tokens 停因原样透出
    expect(dones[0]).toMatchObject({ stopReason: 'max_tokens', usage: { inputTokens: 2, outputTokens: 3 } })
    expect(events.at(-1)!.type).toBe('done')
  })

  it('incomplete → error：同款忽略', async () => {
    const events = await run(
      { messages: [{ role: 'user', content: '继续写' }] },
      [
        { type: 'response.output_text.delta', delta: '正文增量' },
        INCOMPLETE_MAX,
        { type: 'error', message: 'gateway late error' },
      ],
    )
    expect(events.some((e) => e.type === 'error')).toBe(false)
    expect(events.filter((e) => e.type === 'done')).toHaveLength(1)
    expect(events.at(-1)!.type).toBe('done')
  })

  it('回归护栏：incomplete 正常收尾不受影响（无流尾事件时 done 唯一、usage 不变）', async () => {
    const events = await run(
      { messages: [{ role: 'user', content: '继续写' }] },
      [
        { type: 'response.output_text.delta', delta: '正文增量' },
        INCOMPLETE_MAX,
      ],
    )
    expect(events.some((e) => e.type === 'error')).toBe(false)
    const dones = events.filter((e) => e.type === 'done')
    expect(dones).toHaveLength(1)
    expect(dones[0]).toMatchObject({ stopReason: 'max_tokens', usage: { inputTokens: 2, outputTokens: 3 } })
  })
})
