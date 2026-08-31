/**
 * R32-1 / R32-2（三十二轮）回归——错误路径 usage 上抛（B-12 通道三线对齐）：
 *
 * - R32-1（anthropic 线）：流结束无终止事件（无 message_delta）的传输截断 error 须随错
 *   上抛已发生消耗——message_start 实测 input/cache 优先，output 按累计产出折算，
 *   标 estimated。修复前截断 error 不带 usage，runner 终态失败按 0 成本入账丢计费。
 * - R32-2（responses 线）：① incomplete 非 max_output_tokens；② response.failed；
 *   ③ 流中裸 error 事件；④ 无终止事件截断兜底——四条错误路径全部随错上抛 usage
 *   （上游 usage 在手即真值，否则 estimateDoneUsage 折算），与 R31-1 openai 线同口径。
 */
import { describe, expect, it } from 'vitest'
import Anthropic from '@anthropic-ai/sdk'
import OpenAI from 'openai'
import { createAnthropicProvider } from '../../../src/ai/provider/anthropic-adapter.js'
import { createOpenAIResponsesProvider } from '../../../src/ai/provider/responses-adapter.js'
import type { GenEvent, GenRequest, ProviderConf } from '../../../src/ai/provider/index.js'

const CONF = {
  id: 't1',
  name: 't',
  protocol: 'anthropic' as const,
  auth: 'anthropic' as const,
  baseUrl: 'https://example.local',
  model: 'test-model',
  apiKey: 'sk-secret-key',
  caps: null,
} as ProviderConf

const RCONF: ProviderConf = { ...CONF, protocol: 'openai-responses', model: 'gpt-5' }

const REQ: GenRequest = { systemPrompt: '', messages: [{ role: 'user', content: 'hi' }] }

async function collect(prov: { stream(req: GenRequest, signal: AbortSignal): AsyncIterable<GenEvent> }, req: GenRequest): Promise<GenEvent[]> {
  const out: GenEvent[] = []
  for await (const ev of prov.stream(req, new AbortController().signal)) out.push(ev)
  return out
}

function fakeSend(events: unknown[]): () => AsyncGenerator<unknown> {
  return async function* () {
    for (const e of events) yield e
  }
}

function findError(evs: GenEvent[]): Extract<GenEvent, { type: 'error' }> | undefined {
  return evs.find((e) => e.type === 'error') as Extract<GenEvent, { type: 'error' }> | undefined
}

describe('R32-1：anthropic 截断 error 随错上抛 usage', () => {
  it('message_start 实测 input/cache + 半截 delta、无 message_delta → error 带 usage（实测 input/cache + 估计 output）', async () => {
    const client = {
      messages: {
        create: fakeSend([
          { type: 'message_start', message: { usage: { input_tokens: 12, cache_read_input_tokens: 7, cache_creation_input_tokens: 3 } } },
          { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
          { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '半截' } },
          { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '正文' } },
          // 流在此正常结束——message_delta（stop_reason/usage 终态）永不到达
        ]),
      },
    } as unknown as Anthropic
    const evs = await collect(createAnthropicProvider(CONF, client), REQ)
    expect(evs.some((e) => e.type === 'done')).toBe(false)
    const err = findError(evs)
    expect(err).toBeDefined()
    expect(err).toMatchObject({ retryable: true, code: 'NETWORK' })
    if (err) expect(err.message).toContain('传输截断')
    // usage：input/cache 用 message_start 实测值；output 按累计产出折算（>0，estimated）
    expect(err?.usage).toMatchObject({ inputTokens: 12, cacheReadTokens: 7, cacheWriteTokens: 3, estimated: true })
    expect(err?.usage?.outputTokens).toBeGreaterThan(0)
  })

  it('连 message_start 都没有（网关直接吐 delta）→ error 带 usage（input 按请求折算）', async () => {
    const client = {
      messages: {
        create: fakeSend([
          { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
          { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '半截' } },
        ]),
      },
    } as unknown as Anthropic
    const evs = await collect(createAnthropicProvider(CONF, client), REQ)
    const err = findError(evs)
    expect(err).toBeDefined()
    expect(err?.usage).toBeDefined()
    expect(err?.usage?.inputTokens).toBeGreaterThan(0)
    expect(err?.usage?.estimated).toBe(true)
  })
})

describe('R32-2：responses 线四条错误路径随错上抛 usage', () => {
  function fakeResponsesClient(events: unknown[]): OpenAI {
    return {
      responses: {
        create: async (): Promise<AsyncGenerator<unknown>> =>
          (async function* () {
            for (const e of events) yield e
          })(),
      },
    } as unknown as OpenAI
  }

  it('incomplete(content_filter) 带 usage → error 携上游真值', async () => {
    const client = fakeResponsesClient([
      { type: 'response.output_text.delta', delta: '半截' },
      { type: 'response.incomplete', response: { incomplete_details: { reason: 'content_filter' }, usage: { input_tokens: 15, output_tokens: 5 } } },
    ])
    const evs = await collect(createOpenAIResponsesProvider(RCONF, client), REQ)
    expect(evs.some((e) => e.type === 'done')).toBe(false)
    const err = findError(evs)
    expect(err).toBeDefined()
    if (err) expect(err.message).toContain('content_filter')
    expect(err?.usage).toMatchObject({ inputTokens: 15, outputTokens: 5 })
  })

  it('incomplete(content_filter) 无 usage → error 携估计值（estimated）', async () => {
    const client = fakeResponsesClient([
      { type: 'response.output_text.delta', delta: '半截' },
      { type: 'response.incomplete', response: { incomplete_details: { reason: 'content_filter' } } },
    ])
    const evs = await collect(createOpenAIResponsesProvider(RCONF, client), REQ)
    const err = findError(evs)
    expect(err?.usage).toBeDefined()
    expect(err?.usage?.inputTokens).toBeGreaterThan(0)
    expect(err?.usage?.outputTokens).toBeGreaterThan(0)
  })

  it('response.failed 带 response.usage → error 携上游真值', async () => {
    const client = fakeResponsesClient([
      { type: 'response.failed', response: { error: { code: 'server_error', message: 'boom' }, usage: { input_tokens: 9, output_tokens: 4 } } },
    ])
    const evs = await collect(createOpenAIResponsesProvider(RCONF, client), REQ)
    const err = findError(evs)
    expect(err).toBeDefined()
    expect(err?.usage).toMatchObject({ inputTokens: 9, outputTokens: 4 })
  })

  it('流中裸 error 事件 → error 携估计值（estimated）', async () => {
    const client = fakeResponsesClient([
      { type: 'response.output_text.delta', delta: '半截' },
      { type: 'error', message: 'gateway mid-stream failure' },
    ])
    const evs = await collect(createOpenAIResponsesProvider(RCONF, client), REQ)
    const err = findError(evs)
    expect(err).toBeDefined()
    expect(err?.usage?.inputTokens).toBeGreaterThan(0)
    expect(err?.usage?.outputTokens).toBeGreaterThan(0)
  })

  it('无终止事件（截断兜底）→ NETWORK error 携估计值（含残留 tool 参数并入产出）', async () => {
    const client = fakeResponsesClient([
      { type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', call_id: 'call-1', name: 'search' } },
      { type: 'response.function_call_arguments.delta', item_id: 'fc1', output_index: 0, delta: '{"q":"风起"}' },
      // 无 output_item.done、无任何终止事件——流直接结束
    ])
    const evs = await collect(createOpenAIResponsesProvider(RCONF, client), REQ)
    expect(evs.some((e) => e.type === 'done')).toBe(false)
    const err = findError(evs)
    expect(err).toMatchObject({ retryable: true, code: 'NETWORK' })
    if (err) expect(err.message).toContain('传输截断')
    // 截断兜底 usage 在 toolAccum flush/clear 之前估计——残留调用参数计入产出
    expect(err?.usage?.inputTokens).toBeGreaterThan(0)
    expect(err?.usage?.outputTokens).toBeGreaterThan(0)
  })
})
