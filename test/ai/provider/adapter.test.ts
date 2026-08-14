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
import { createOpenAIProvider, createOpenAIProviderChat } from '../../../src/ai/provider/openai-adapter.js'
import { createOpenAIResponsesProvider } from '../../../src/ai/provider/responses-adapter.js'
import type { GenEvent, GenRequest, ProviderConf } from '../../../src/ai/provider/index.js'
import type { ProviderStore } from '../../../src/ai/provider/store.js'

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

const REQ: GenRequest = { systemPrompt: '', messages: [{ role: 'user', content: 'hi' }] }

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

  it('Chat Completions 不发 max_tokens（让模型用默认值）', async () => {
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
    const conf = { ...CONF, protocol: 'openai' as const, model: 'gpt-4o' } as ProviderConf
    await collect(createOpenAIProvider(conf, client), REQ)
    expect(captured).toMatchObject({ model: 'gpt-4o' })
    expect('max_completion_tokens' in (captured ?? {})).toBe(false)
    expect('max_tokens' in (captured ?? {})).toBe(false)
  })

  it('unknown 系列模型不发 reasoning_effort（quirks 保守省略，防 400）', async () => {
    let captured: Record<string, unknown> | null = null
    const client = {
      chat: {
        completions: {
          create: async (params: unknown) => {
            captured = params as Record<string, unknown>
            return (async function* () {
              yield { choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] }
            })()
          },
        },
      },
    } as unknown as OpenAI
    const conf = { ...CONF, protocol: 'openai' as const, model: 'custom-model' } as ProviderConf
    await collect(createOpenAIProvider(conf, client), { ...REQ, effort: 'high' })
    expect('reasoning_effort' in (captured ?? {})).toBe(false)
  })

  it('gpt 系列模型发 reasoning_effort（xhigh/max → high）', async () => {
    let captured: Record<string, unknown> | null = null
    const client = {
      chat: {
        completions: {
          create: async (params: unknown) => {
            captured = params as Record<string, unknown>
            return (async function* () {
              yield { choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] }
            })()
          },
        },
      },
    } as unknown as OpenAI
    const conf = { ...CONF, protocol: 'openai' as const, model: 'gpt-4o' } as ProviderConf
    await collect(createOpenAIProvider(conf, client), { ...REQ, effort: 'xhigh' })
    expect(captured?.['reasoning_effort']).toBe('high')
    expect(captured?.['max_tokens']).toBeUndefined()
  })

  it('o 系列模型 → Responses 线格式（input 数组 + max_output_tokens）', async () => {
    let captured: Record<string, unknown> | null = null
    const client = {
      responses: {
        create: async (params: unknown) => {
          captured = params as Record<string, unknown>
          return (async function* () {})()
        },
      },
    } as unknown as OpenAI
    const conf = { ...CONF, protocol: 'openai-responses' as const, model: 'o3-mini' } as ProviderConf
    await collect(createOpenAIResponsesProvider(conf, client), { ...REQ, maxTokens: 100 })
    expect(captured).toMatchObject({ model: 'o3-mini', max_output_tokens: 100 })
    expect('max_tokens' in (captured ?? {})).toBe(false)
  })
})

describe('Anthropic 适配器 400 降级（§6.5：仅 structured 一级 + 记忆）', () => {
  it('output_config.format 400 → 剥 structured 重试成功', async () => {
    let callCount = 0
    const client = {
      messages: {
        create: async (params: unknown) => {
          callCount++
          // 第一次含 output_config.format → 模拟 400
          const p = params as Record<string, unknown>
          if (p['output_config'] && (p['output_config'] as Record<string, unknown>)['format']) {
            throw new Anthropic.APIError(400, { type: 'error', message: 'bad request' }, 'bad request', undefined)
          }
          // 第二次不含 → 正常返回
          return (async function* () {
            yield { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }
            yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } }
            yield { type: 'content_block_stop', index: 0 }
            yield { type: 'message_delta', usage: { input_tokens: 1, output_tokens: 1 }, delta: { stop_reason: 'end_turn' } }
          })()
        },
      },
    } as unknown as Anthropic
    // claude 系列 structuredMode=json_schema → 发 format → 400 → 剥 structured 重试
    const evs = await collect(
      createAnthropicProvider({ ...CONF, model: 'claude-sonnet-5' } as ProviderConf, client),
      { ...REQ, structured: { schema: { type: 'object', properties: {} } } },
    )
    expect(callCount).toBe(2) // 第一次 400 → 第二次降级成功
    expect(evs.some((e) => e.type === 'text')).toBe(true)
    expect(evs.some((e) => e.type === 'done')).toBe(true)
  })

  it('降级命中 → 写记忆（structured 不支持），下次直接跳过 structured 单次请求', async () => {
    let callCount = 0
    const client = {
      messages: {
        create: async (params: unknown) => {
          callCount++
          const p = params as Record<string, unknown>
          if (p['output_config'] && (p['output_config'] as Record<string, unknown>)['format']) {
            throw new Anthropic.APIError(400, { type: 'error', message: 'bad request' }, 'bad request', undefined)
          }
          return (async function* () {
            yield { type: 'message_delta', usage: { input_tokens: 1, output_tokens: 1 }, delta: { stop_reason: 'end_turn' } }
          })()
        },
      },
    } as unknown as Anthropic
    const store: ProviderStore = {
      providers: [],
      currentId: null,
      currentModel: null,
      modelCaps: {},
      tiers: { creative: { model: '', effort: 'high' }, assistant: null, chat: null },
      vault: null,
      dek: null,
    }
    const prov = createAnthropicProvider({ ...CONF, model: 'claude-sonnet-5' } as ProviderConf, client, store)
    // 第一次：带 structured → 400 → 降级重试 → 建流成功才写记忆
    await collect(prov, { ...REQ, structured: { schema: {} } })
    expect(store.modelCaps['t1/claude-sonnet-5']).toEqual({ structured: false })
    // 第二次：记忆命中 → 首发即剥 structured，一次请求即成功（不再 400 重试）
    callCount = 0
    const evs2 = await collect(prov, { ...REQ, structured: { schema: {} } })
    expect(callCount).toBe(1)
    // 不止 callCount=1——必须真的成功产出（记忆不得关闭降级链导致必败）
    expect(evs2.some((e) => e.type === 'done')).toBe(true)
    expect(evs2.some((e) => e.type === 'error')).toBe(false)
  })

  it('effort 400 不再降级（表驱动后该发的才发，此 400 直接透传）', async () => {
    const err = new Anthropic.APIError(400, { type: 'error', message: 'output_config not supported' }, 'bad', undefined)
    let callCount = 0
    const client = {
      messages: {
        create: async () => { callCount++; throw err },
      },
    } as unknown as Anthropic
    // claude 系列发 effort（output_config）→ 网关仍 400 → 直接报错（不再剥 effort 重试）
    const evs = await collect(createAnthropicProvider({ ...CONF, model: 'claude-sonnet-5' } as ProviderConf, client), { ...REQ, effort: 'high' })
    expect(callCount).toBe(1) // 一次即止
    expect(evs[0]).toMatchObject({ type: 'error', retryable: false })
  })

  it('unknown 系列（anthropicEffortWire=null）不发 effort → 无降级', async () => {
    let callCount = 0
    const client = {
      messages: {
        create: async () => {
          callCount++
          // unknown 系列表不发 effort → 这里不会 400（验证表驱动后首发即对）
          return (async function* () {
            yield { type: 'message_delta', usage: { input_tokens: 1, output_tokens: 1 }, delta: { stop_reason: 'end_turn' } }
          })()
        },
      },
    } as unknown as Anthropic
    const evs = await collect(createAnthropicProvider(CONF, client), { ...REQ, effort: 'high' })
    expect(callCount).toBe(1) // 首发即对，无降级
    expect(evs.some((e) => e.type === 'done')).toBe(true)
  })

  it('非 structured 相关的 400 不降级（直接报错）', async () => {
    const err = new Anthropic.APIError(400, { type: 'error', message: 'invalid model' }, 'invalid model', undefined)
    const client = { messages: { create: () => Promise.reject(err) } } as unknown as Anthropic
    const evs = await collect(createAnthropicProvider(CONF, client), REQ)
    expect(evs[0]).toMatchObject({ type: 'error', retryable: false })
  })
})
describe('OpenAI Responses 适配器', () => {
  const O_CONF = { ...CONF, protocol: 'openai' as const, model: 'o3-mini' } as ProviderConf

  it('output_text.delta → text 事件；response.completed usage → done', async () => {
    const client = {
      responses: {
        create: fakeSend([
          { type: 'response.output_text.delta', delta: '你' },
          { type: 'response.output_text.delta', delta: '好' },
          {
            type: 'response.completed',
            response: { status: 'completed', usage: { input_tokens: 5, output_tokens: 2 }, output_text: '你好' },
          },
        ]),
      },
    } as unknown as OpenAI
    const evs = await collect(createOpenAIResponsesProvider(O_CONF, client), REQ)
    expect(evs.filter((e) => e.type === 'text')).toEqual([
      { type: 'text', delta: '你' },
      { type: 'text', delta: '好' },
    ])
    const done = evs.find((e) => e.type === 'done')
    expect(done).toMatchObject({ type: 'done', usage: { inputTokens: 5, outputTokens: 2 }, stopReason: 'stop' })
  })

  it('function_call_arguments 增量 + output_item.done → tool 事件（完整 JSON）', async () => {
    const client = {
      responses: {
        create: fakeSend([
          { type: 'response.function_call_arguments.delta', item_id: 'fc_1', delta: '{"标题":' },
          { type: 'response.function_call_arguments.delta', item_id: 'fc_1', delta: '"x","正文":"y"}' },
          {
            type: 'response.output_item.done',
            item: { id: 'fc_1', type: 'function_call', call_id: 'call_1', name: 'submit_chapter', arguments: '' },
          },
          { type: 'response.completed', response: { status: 'completed', usage: { input_tokens: 1, output_tokens: 1 } } },
        ]),
      },
    } as unknown as OpenAI
    const evs = await collect(createOpenAIResponsesProvider(O_CONF, client), REQ)
    const tool = evs.find((e) => e.type === 'tool')
    expect(tool).toMatchObject({ type: 'tool', id: 'call_1', name: 'submit_chapter', input: { 标题: 'x', 正文: 'y' } })
  })

  it('response.incomplete（max_output_tokens）→ done stopReason=max_tokens', async () => {
    const client = {
      responses: {
        create: fakeSend([
          { type: 'response.output_text.delta', delta: '截断' },
          {
            type: 'response.incomplete',
            response: { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, usage: { input_tokens: 1, output_tokens: 500 } },
          },
        ]),
      },
    } as unknown as OpenAI
    const evs = await collect(createOpenAIResponsesProvider(O_CONF, client), REQ)
    const done = evs.find((e) => e.type === 'done')
    expect(done).toMatchObject({ type: 'done', stopReason: 'max_tokens' })
  })

  it('text.format 400 → 去 structured 重试成功', async () => {
    let callCount = 0
    const client = {
      responses: {
        create: async (params: unknown) => {
          callCount++
          const p = params as Record<string, unknown>
          if (p['text'] && (p['text'] as Record<string, unknown>)['format']) {
            throw new OpenAI.APIError(400, { type: 'error', message: 'bad request' }, 'bad request', undefined)
          }
          return (async function* () {
            yield { type: 'response.output_text.delta', delta: 'ok' }
            yield { type: 'response.completed', response: { status: 'completed', usage: { input_tokens: 1, output_tokens: 1 } } }
          })()
        },
      },
    } as unknown as OpenAI
    const evs = await collect(createOpenAIResponsesProvider(O_CONF, client), { ...REQ, structured: { schema: { type: 'object' } } })
    expect(callCount).toBe(2)
    expect(evs.some((e) => e.type === 'text')).toBe(true)
    expect(evs.some((e) => e.type === 'done')).toBe(true)
  })

  it('非 400 错误不降级（直接报错）', async () => {
    const err = new OpenAI.APIError(500, { type: 'error', message: 'server error' }, 'server error', undefined)
    const client = { responses: { create: () => Promise.reject(err) } } as unknown as OpenAI
    const evs = await collect(createOpenAIResponsesProvider(O_CONF, client), { ...REQ, structured: { schema: { type: 'object' } } })
    expect(evs[0]).toMatchObject({ type: 'error', retryable: true })
  })
})

describe('OpenAI 适配器线格式分派（按 protocol）', () => {
  it('openai-responses 协议 → responses.create（Responses API）', async () => {
    let responsesCalled = false
    const client = {
      responses: {
        create: async () => {
          responsesCalled = true
          return (async function* () {})()
        },
      },
    } as unknown as OpenAI
    const conf = { ...CONF, protocol: 'openai-responses' as const, model: 'o3-mini' } as ProviderConf
    await collect(createOpenAIResponsesProvider(conf, client), REQ)
    expect(responsesCalled).toBe(true)
  })

  it('openai 协议 → chat.completions.create（Chat Completions）', async () => {
    let chatCalled = false
    const client = {
      chat: {
        completions: {
          create: async () => {
            chatCalled = true
            return (async function* () {
              yield { choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] }
            })()
          },
        },
      },
    } as unknown as OpenAI
    const conf = { ...CONF, protocol: 'openai' as const, model: 'gpt-4o' } as ProviderConf
    await collect(createOpenAIProviderChat(conf, client), REQ)
    expect(chatCalled).toBe(true)
  })
})

describe('批次3 quirks 参数面（方案 §6）', () => {
  it('kimi：不发采样参数（temperature/top_p），用 max_completion_tokens', async () => {
    let captured: Record<string, unknown> | null = null
    const client = {
      chat: {
        completions: {
          create: async (params: unknown) => {
            captured = params as Record<string, unknown>
            return (async function* () {
              yield { choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] }
            })()
          },
        },
      },
    } as unknown as OpenAI
    const conf = { ...CONF, protocol: 'openai' as const, model: 'kimi-k3' } as ProviderConf
    await collect(createOpenAIProvider(conf, client), { ...REQ, maxTokens: 100 })
    expect(captured).not.toHaveProperty('temperature')
    expect(captured).not.toHaveProperty('top_p')
    expect(captured).toHaveProperty('max_completion_tokens', 100)
  })

  it('glm：不发 stream_options（无此参数），用 max_tokens', async () => {
    let captured: Record<string, unknown> | null = null
    const client = {
      chat: {
        completions: {
          create: async (params: unknown) => {
            captured = params as Record<string, unknown>
            return (async function* () {
              yield { choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] }
            })()
          },
        },
      },
    } as unknown as OpenAI
    const conf = { ...CONF, protocol: 'openai' as const, model: 'glm-5.2' } as ProviderConf
    await collect(createOpenAIProvider(conf, client), { ...REQ, maxTokens: 100 })
    expect(captured).not.toHaveProperty('stream_options')
    expect(captured).toHaveProperty('max_tokens', 100)
  })

  it('usage 双兜底：usage 在 choices[0] 也能提取（Kimi 文档矛盾）', async () => {
    const client = {
      chat: {
        completions: {
          create: fakeSend([
            { choices: [{ delta: { content: 'ok' }, finish_reason: 'stop', usage: { prompt_tokens: 7, completion_tokens: 3 } }] },
          ]),
        },
      },
    } as unknown as OpenAI
    const evs = await collect(createOpenAIProvider(CONF, client), REQ)
    const done = evs.find((e) => e.type === 'done')
    expect(done).toMatchObject({ type: 'done', usage: { inputTokens: 7, outputTokens: 3 } })
  })

  it('anthropic DeepSeek 兼容端点：effort 档位收敛（medium→high、xhigh→max）', async () => {
    let sentParams: Record<string, unknown> | undefined
    const client = {
      messages: {
        create: async (params: unknown) => {
          sentParams = params as Record<string, unknown>
          return (async function* () {
            yield { type: 'message_start', message: { usage: { input_tokens: 1 } } }
            yield { type: 'message_delta', usage: { output_tokens: 1 }, delta: { stop_reason: 'end_turn' } }
          })()
        },
      },
    } as unknown as Anthropic
    const conf = { ...CONF, protocol: 'anthropic' as const, model: 'deepseek-chat' } as ProviderConf
    await collect(createAnthropicProvider(conf, client), { ...REQ, effort: 'xhigh' })
    expect((sentParams?.['output_config'] as { effort: string })?.effort).toBe('max')
  })
})

describe('Grok 工具整块 chunk（方案 §6：流式 tool_calls 单 chunk 不分片）', () => {
  it('整块 arguments 一次到达 → tool 事件（不依赖增量拼装）', async () => {
    const client = {
      chat: {
        completions: {
          create: fakeSend([
            {
              choices: [
                {
                  delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'submit', arguments: '{"a":1,"b":"x"}' } }] },
                  finish_reason: 'tool_calls',
                },
              ],
            },
          ]),
        },
      },
    } as unknown as OpenAI
    const conf = { ...CONF, protocol: 'openai' as const, model: 'grok-4.6' } as ProviderConf
    const evs = await collect(createOpenAIProvider(conf, client), REQ)
    const tool = evs.find((e) => e.type === 'tool')
    expect(tool).toMatchObject({ type: 'tool', name: 'submit', input: { a: 1, b: 'x' } })
  })
})

describe('批次2 reasoning 思维链（方案 §4.2）', () => {
  it('chat 适配器：delta.reasoning_content → reasoning 事件', async () => {
    const client = {
      chat: {
        completions: {
          create: fakeSend([
            { choices: [{ delta: { reasoning_content: '思考中…' }, finish_reason: null }] },
            { choices: [{ delta: { content: '结论' }, finish_reason: 'stop' }] },
          ]),
        },
      },
    } as unknown as OpenAI
    const evs = await collect(createOpenAIProvider(CONF, client), REQ)
    expect(evs.filter((e) => e.type === 'reasoning')).toEqual([{ type: 'reasoning', delta: '思考中…' }])
  })

  it('chat 适配器：assistant 消息的 reasoning 块 → 写回 reasoning_content 字段', async () => {
    let sentParams: Record<string, unknown> | undefined
    const client = {
      chat: {
        completions: {
          create: async (params: unknown) => {
            sentParams = params as Record<string, unknown>
            return (async function* () {
              yield { choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] }
            })()
          },
        },
      },
    } as unknown as OpenAI
    const req: GenRequest = {
      systemPrompt: '',
      messages: [
        {
          role: 'assistant',
          content: [
            { type: 'text', text: '回答' },
            { type: 'reasoning', text: '推理过程' },
            { type: 'tool_use', id: 'c1', name: 'submit', input: { a: 1 } },
          ],
        },
      ],
    }
    await collect(createOpenAIProvider(CONF, client), req)
    const asstMsg = (sentParams?.messages as Record<string, unknown>[])[0]
    expect(asstMsg).toMatchObject({
      role: 'assistant',
      content: '回答',
      reasoning_content: '推理过程',
      tool_calls: [{ id: 'c1', type: 'function', function: { name: 'submit', arguments: '{"a":1}' } }],
    })
  })

  it('anthropic 适配器：reasoning 块静默丢弃（原生端点无此回传）', async () => {
    let sentParams: Record<string, unknown> | undefined
    const client = {
      messages: {
        create: async (params: unknown) => {
          sentParams = params as Record<string, unknown>
          return (async function* () {
            yield { type: 'message_start', message: { usage: { input_tokens: 1 } } }
            yield { type: 'message_delta', usage: { output_tokens: 1 }, delta: { stop_reason: 'end_turn' } }
          })()
        },
      },
    } as unknown as Anthropic
    const req: GenRequest = {
      systemPrompt: '',
      messages: [
        {
          role: 'assistant',
          content: [
            { type: 'text', text: '回答' },
            { type: 'reasoning', text: '推理过程' },
          ],
        },
      ],
    }
    await collect(createAnthropicProvider(CONF, client), req)
    // 只回传 text，reasoning 被过滤
    expect((sentParams?.messages as Record<string, unknown>[])[0]).toEqual({
      role: 'assistant',
      content: [{ type: 'text', text: '回答' }],
    })
  })
})
