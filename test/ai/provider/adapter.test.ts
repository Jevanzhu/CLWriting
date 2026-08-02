/**
 * 双协议适配器单测（审查 §七：两个适配器零单测）。
 *
 * 注入假 SDK 客户端 → 验证协议事件翻译成统一 GenEvent：
 * text 增量 / tool_use input_json_delta 增量拼装 / usage 提取 / done 幂等 /
 * APIError → retryable 归因（429/5xx）/ AbortError → 「已中断」。
 */
import { describe, expect, it } from 'vitest'
import Anthropic from '@anthropic-ai/sdk'
import OpenAI from 'openai'
import { createAnthropicProvider } from '../../../src/ai/provider/anthropic-adapter.js'
import { createOpenAIProvider } from '../../../src/ai/provider/openai-adapter.js'
import type { GenEvent, GenRequest, ProviderConf } from '../../../src/ai/provider/index.js'

const CONF = {
  name: 't',
  protocol: 'anthropic' as const,
  auth: 'anthropic' as const,
  baseUrl: 'https://example.local',
  model: 'test-model',
  apiKey: 'sk-secret-key',
  caps: null,
} as ProviderConf

const REQ: GenRequest = { systemPrompt: '', messages: [{ role: 'user', content: 'hi' }], maxTokens: 100 }

async function collect(prov: ReturnType<typeof createAnthropicProvider>, req: GenRequest): Promise<GenEvent[]> {
  const out: GenEvent[] = []
  for await (const ev of prov.stream(req, new AbortController().signal)) out.push(ev)
  return out
}

// 假事件流：客户端返回 async generator（as unknown 削减 SDK 类型）
function fakeSend(events: unknown[]): () => AsyncGenerator<unknown> {
  return async function* () {
    for (const e of events) yield e
  }
}

describe('Anthropic 适配器', () => {
  it('text_delta → text 事件 + message_delta usage → done', async () => {
    const client = {
      messages: {
        create: fakeSend([
          { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
          { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '你' } },
          { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '好' } },
          { type: 'content_block_stop', index: 0 },
          { type: 'message_delta', usage: { input_tokens: 5, output_tokens: 2 }, delta: { stop_reason: 'end_turn' } },
        ]),
      },
    } as unknown as Anthropic
    const evs = await collect(createAnthropicProvider(CONF, client), REQ)
    expect(evs.filter((e) => e.type === 'text')).toEqual([
      { type: 'text', delta: '你' },
      { type: 'text', delta: '好' },
    ])
    const done = evs.find((e) => e.type === 'done')
    expect(done).toMatchObject({ type: 'done', usage: { inputTokens: 5, outputTokens: 2 } })
  })

  it('input_json_delta 增量拼装 → tool 事件（审查 §五 契约核心）', async () => {
    const client = {
      messages: {
        create: fakeSend([
          { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', name: 'submit_chapter' } },
          { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"标题":' } },
          { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '"x","正文":"y"}' } },
          { type: 'content_block_stop', index: 0 },
          { type: 'message_delta', usage: { input_tokens: 1, output_tokens: 1 }, delta: { stop_reason: 'tool_use' } },
        ]),
      },
    } as unknown as Anthropic
    const evs = await collect(createAnthropicProvider(CONF, client), REQ)
    const tool = evs.find((e) => e.type === 'tool')
    expect(tool).toMatchObject({ type: 'tool', name: 'submit_chapter', input: { 标题: 'x', 正文: 'y' } })
  })

  it('tool JSON 损坏 → input 降级 { _raw }，不崩', async () => {
    const client = {
      messages: {
        create: fakeSend([
          { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', name: 'submit_text' } },
          { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{broken' } },
          { type: 'content_block_stop', index: 0 },
          { type: 'message_delta', usage: { input_tokens: 1, output_tokens: 1 }, delta: { stop_reason: 'tool_use' } },
        ]),
      },
    } as unknown as Anthropic
    const evs = await collect(createAnthropicProvider(CONF, client), REQ)
    const tool = evs.find((e) => e.type === 'tool')
    expect(tool).toMatchObject({ type: 'tool', input: { _raw: '{broken' } })
  })

  it('重复 message_delta → done 幂等（只发一次）', async () => {
    const client = {
      messages: {
        create: fakeSend([
          { type: 'message_delta', usage: { input_tokens: 1, output_tokens: 1 }, delta: { stop_reason: 'end_turn' } },
          { type: 'message_delta', usage: { input_tokens: 9, output_tokens: 9 }, delta: { stop_reason: 'end_turn' } },
        ]),
      },
    } as unknown as Anthropic
    const evs = await collect(createAnthropicProvider(CONF, client), REQ)
    expect(evs.filter((e) => e.type === 'done')).toHaveLength(1)
  })

  it('APIError 429 → error 事件 retryable=true', async () => {
    const err = new Anthropic.APIError(429, { type: 'error', message: 'rate limited' }, 'rate limited', undefined)
    const client = {
      messages: { create: async () => Promise.reject(err) },
    } as unknown as Anthropic
    const evs = await collect(createAnthropicProvider(CONF, client), REQ)
    expect(evs[0]).toMatchObject({ type: 'error', retryable: true })
    const first = evs[0]
    if (first && first.type === 'error') expect(first.message).toContain('Anthropic API 429')
  })

  it('AbortError → error「已中断」', async () => {
    const abort = new Error('cancel') as Error & { name: 'AbortError' }
    abort.name = 'AbortError'
    const client = { messages: { create: () => Promise.reject(abort) } } as unknown as Anthropic
    const evs = await collect(createAnthropicProvider(CONF, client), REQ)
    expect(evs[0]).toMatchObject({ type: 'error', message: '已中断', retryable: false })
  })

  it('message_start 缓存 input_tokens（message_delta 不含时回退，P2-3）', async () => {
    const client = {
      messages: {
        create: fakeSend([
          { type: 'message_start', message: { usage: { input_tokens: 100, output_tokens: 1 } } },
          { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
          { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hi' } },
          { type: 'content_block_stop', index: 0 },
          { type: 'message_delta', usage: { output_tokens: 50 }, delta: { stop_reason: 'end_turn' } },
        ]),
      },
    } as unknown as Anthropic
    const evs = await collect(createAnthropicProvider(CONF, client), REQ)
    const done = evs.find((e) => e.type === 'done')
    // message_delta 无 input_tokens → 回退 message_start 缓存的 100
    expect(done).toMatchObject({ type: 'done', usage: { inputTokens: 100, outputTokens: 50 } })
  })
})

describe('OpenAI 适配器', () => {
  it('content 增量 → text 事件；finish_reason → done', async () => {
    const client = {
      chat: {
        completions: {
          create: fakeSend([
            { choices: [{ delta: { content: '你' }, finish_reason: null }] },
            { choices: [{ delta: { content: '好' }, finish_reason: 'stop' }] },
          ]),
        },
      },
    } as unknown as OpenAI
    const evs = await collect(createOpenAIProvider(CONF, client), REQ)
    expect(evs.filter((e) => e.type === 'text')).toEqual([
      { type: 'text', delta: '你' },
      { type: 'text', delta: '好' },
    ])
    expect(evs.some((e) => e.type === 'done')).toBe(true)
  })

  it('tool_calls 增量拼装 → tool 事件（index 聚合 arguments）', async () => {
    const client = {
      chat: {
        completions: {
          create: fakeSend([
            {
              choices: [
                {
                  delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'submit_chapter', arguments: '{"标题":' } }] },
                  finish_reason: null,
                },
              ],
            },
            {
              choices: [
                {
                  delta: { tool_calls: [{ index: 0, function: { arguments: '"x"}' } }] },
                  finish_reason: 'tool_calls',
                },
              ],
            },
          ]),
        },
      },
    } as unknown as OpenAI
    const evs = await collect(createOpenAIProvider(CONF, client), REQ)
    const tool = evs.find((e) => e.type === 'tool')
    expect(tool).toMatchObject({ type: 'tool', name: 'submit_chapter', input: { 标题: 'x' } })
  })

  it('usage-only chunk → done 带 usage（stream_options.include_usage）', async () => {
    const client = {
      chat: {
        completions: {
          create: fakeSend([
            { choices: [{ delta: { content: 'x' }, finish_reason: null }] },
            { choices: [], usage: { prompt_tokens: 8, completion_tokens: 4 } },
          ]),
        },
      },
    } as unknown as OpenAI
    const evs = await collect(createOpenAIProvider(CONF, client), REQ)
    const done = evs.find((e) => e.type === 'done')
    expect(done).toMatchObject({ type: 'done', usage: { inputTokens: 8, outputTokens: 4 } })
  })

  it('APIError 5xx → error 事件 retryable=true；message 带脱敏状态码', async () => {
    const err = new OpenAI.APIError(500, { type: 'error', message: 'server meltdown' }, 'server meltdown', undefined)
    const client = { chat: { completions: { create: () => Promise.reject(err) } } } as unknown as OpenAI
    const evs = await collect(createOpenAIProvider(CONF, client), REQ)
    expect(evs[0]).toMatchObject({ type: 'error', retryable: true })
    const first = evs[0]
    if (first && first.type === 'error') expect(first.message).toContain('OpenAI API 500')
  })

  it('o 系列模型用 max_completion_tokens（翻译到 params）', async () => {
    let captured: Record<string, unknown> | null = null
    const client = {
      chat: {
        completions: {
          create: async (params: unknown) => {
            captured = params as Record<string, unknown>
            return (async function* () {})()
          },
        },
      },
    } as unknown as OpenAI
    const conf = { ...CONF, model: 'o4-mini' } as ProviderConf
    await collect(createOpenAIProvider(conf, client), REQ)
    expect(captured).toMatchObject({ model: 'o4-mini' })
    expect('max_completion_tokens' in (captured ?? {})).toBe(true)
    expect('max_tokens' in (captured ?? {})).toBe(false)
  })
})