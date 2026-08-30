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
import { generateTool } from '../../../src/ai/gen.js'
import type { GenEvent, GenRequest, ModelProvider, ProviderConf } from '../../../src/ai/provider/index.js'
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

  // 低级项（第六轮）：兼容端点不发 tool_use id → 按 block index 生成兜底（空 id 进
  // 历史会被 tool_result 关联拒绝；对齐 OpenAI 线 P3-Q5 的 call_ 兜底）
  it('低级项：tool_use 缺 id → 兜底 toolu_<index>，不留空串', async () => {
    const client = {
      messages: {
        create: fakeSend([
          { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', name: 'submit_chapter' } },
          { type: 'content_block_stop', index: 0 },
          { type: 'message_delta', usage: { input_tokens: 1, output_tokens: 1 }, delta: { stop_reason: 'tool_use' } },
        ]),
      },
    } as unknown as Anthropic
    const evs = await collect(createAnthropicProvider(CONF, client), REQ)
    const tool = evs.find((e) => e.type === 'tool')
    expect(tool).toMatchObject({ type: 'tool', id: 'toolu_0', name: 'submit_chapter' })
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
    // R27-2（二十七轮）：值口径改为「末见 wins」（与 openai 线 R26-3 归一）——末 delta
    // 9/9 胜出。R73-13b 锚定的「取首条」与此互斥，随本轮口径统一更新：done 次数幂等
    // （该测试的原始关切——重复 delta 不双发 done）保留不变；真·同值重传形态下末见
    // 与首见同值，去重场景不受影响
    expect(evs.find((e) => e.type === 'done')).toMatchObject({ usage: { inputTokens: 9, outputTokens: 9 } })
  })

  // R73-3（二十一轮 A-3）：Anthropic 协议强制 max_tokens——unknown 家族模型 quirks 无
  // maxOutputTokens，走协议兜底；8192 时写长章必截断且 MAX_TOKENS 终态不可重试，
  // 兜底提到 16384（对齐 quirks 表 claude 档）
  it('unknown 家族模型 max_tokens 协议兜底 16384（R73-3）', async () => {
    let captured: Record<string, unknown> | null = null
    const client = {
      messages: {
        create: (params: unknown) => {
          captured = params as Record<string, unknown>
          return fakeSend([
            { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
            { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '好' } },
            { type: 'content_block_stop', index: 0 },
            { type: 'message_delta', usage: { input_tokens: 1, output_tokens: 1 }, delta: { stop_reason: 'end_turn' } },
          ])()
        },
      },
    } as unknown as Anthropic
    // 'test-model' 不命中任何家族 → quirksFor 无 maxOutputTokens → 兜底链终值
    await collect(createAnthropicProvider(CONF, client), REQ)
    expect(captured).toMatchObject({ model: 'test-model', max_tokens: 16_384 })
  })

  it('req.maxTokens 显式指定时覆盖协议兜底（R73-3 对照）', async () => {
    let captured: Record<string, unknown> | null = null
    const client = {
      messages: {
        create: (params: unknown) => {
          captured = params as Record<string, unknown>
          return fakeSend([
            { type: 'message_delta', usage: { input_tokens: 1, output_tokens: 1 }, delta: { stop_reason: 'end_turn' } },
          ])()
        },
      },
    } as unknown as Anthropic
    await collect(createAnthropicProvider(CONF, client), { ...REQ, maxTokens: 4096 })
    expect(captured).toMatchObject({ max_tokens: 4096 })
  })

  // ── H-2（第六轮）：流结束兜底必须区分「有终止无 usage」与「传输截断」──

  it('H-2：无 message_delta（传输截断）→ error 可重试，不发 done、不伪造 end_turn', async () => {
    const client = {
      messages: {
        // 中转/代理提前断流的形态：yield 了半截文本后迭代器正常 return，无终止事件
        create: fakeSend([
          { type: 'message_start', message: { usage: { input_tokens: 7 } } },
          { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
          { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '半截' } },
        ]),
      },
    } as unknown as Anthropic
    const evs = await collect(createAnthropicProvider(CONF, client), REQ)
    expect(evs.some((e) => e.type === 'done')).toBe(false) // 修复前：伪造 done{7,0,'end_turn'}
    const err = evs.find((e) => e.type === 'error')
    expect(err).toMatchObject({ type: 'error', retryable: true, code: 'NETWORK' })
  })

  it('H-2：有 message_delta（stop_reason）无 usage → done 放行（input 用 message_start 缓存）', async () => {
    const client = {
      messages: {
        create: fakeSend([
          { type: 'message_start', message: { usage: { input_tokens: 7 } } },
          { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '回复' } },
          { type: 'message_delta', delta: { stop_reason: 'max_tokens' } },
        ]),
      },
    } as unknown as Anthropic
    const evs = await collect(createAnthropicProvider(CONF, client), REQ)
    const done = evs.find((e) => e.type === 'done')
    // R73-1：网关吞 usage → 估计入账。input 用 message_start 实测 7；output 按累计
    // 产出文本折算（'回复' 2 码位 × 0.6 → ceil = 2），不再恒 0；estimated 标记估计口径
    expect(done).toMatchObject({
      type: 'done',
      usage: { inputTokens: 7, outputTokens: 2, estimated: true },
      stopReason: 'max_tokens',
    })
    expect(evs.some((e) => e.type === 'error')).toBe(false)
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

  // R65-9（总六十五轮）：网关缺省 tc.index——旧实现并入同一 undefined 键，两个
  // tool_call 的 name/arguments 互相覆盖串拼；改自增兜底键后聚合出两个独立调用
  it('R65-9: tool_call 分片缺 index → 自增兜底键聚合出两个独立调用', async () => {
    const client = {
      chat: {
        completions: {
          create: fakeSend([
            // 两条不带 index 的 tool_call（各一个整块分片，网关缺省 index 的常见形态）
            { choices: [{ delta: { tool_calls: [{ id: 'call_1', function: { name: 'toolA', arguments: '{"a":1}' } }] }, finish_reason: null }] },
            { choices: [{ delta: { tool_calls: [{ id: 'call_2', function: { name: 'toolB', arguments: '{"b":2}' } }] }, finish_reason: 'tool_calls' }] },
          ]),
        },
      },
    } as unknown as OpenAI
    const evs = await collect(createOpenAIProvider(CONF, client), REQ)
    const tools = evs.filter((e) => e.type === 'tool')
    expect(tools).toHaveLength(2) // 旧实现：并入同一键 → 仅 1 个串拼调用
    expect(tools[0]).toMatchObject({ name: 'toolA', input: { a: 1 } })
    expect(tools[1]).toMatchObject({ name: 'toolB', input: { b: 2 } })
  })

  it('R65-9: 缺 index 的续片（无 id/name）归并最近兜底键（同一调用的参数仍拼装完整）', async () => {
    const client = {
      chat: {
        completions: {
          create: fakeSend([
            { choices: [{ delta: { tool_calls: [{ id: 'call_1', function: { name: 'toolA', arguments: '{"a":' } }] }, finish_reason: null }] },
            // 续片不带 index/id/name → 归并 call_1 的兜底键（不得另开键劈碎参数）
            { choices: [{ delta: { tool_calls: [{ function: { arguments: '1}' } }] }, finish_reason: null }] },
            { choices: [{ delta: { tool_calls: [{ id: 'call_2', function: { name: 'toolB', arguments: '{}' } }] }, finish_reason: 'tool_calls' }] },
          ]),
        },
      },
    } as unknown as OpenAI
    const evs = await collect(createOpenAIProvider(CONF, client), REQ)
    const tools = evs.filter((e) => e.type === 'tool')
    expect(tools).toHaveLength(2)
    expect(tools[0]).toMatchObject({ name: 'toolA', input: { a: 1 } })
    expect(tools[1]).toMatchObject({ name: 'toolB', input: {} })
  })

  // ii-1：首个 attempt 已消费流（已 yield 文本）后中途 400 —— 不再换参数面重跑（防重复增量），直接终态错误
  it('ii-1 流中 400 不降级重跑（已消费 → 终态错误，无重复增量）', async () => {
    let calls = 0
    const client = {
      chat: {
        completions: {
          create: async (): Promise<AsyncGenerator<unknown>> => {
            calls += 1
            return (async function* () {
              yield { choices: [{ delta: { content: '半截' }, finish_reason: null }] }
              throw new OpenAI.APIError(400, { type: 'error', message: 'mid-stream bad request' }, 'bad request', undefined)
            })()
          },
        },
      },
    } as unknown as OpenAI
    const evs = await collect(
      createOpenAIProvider({ ...CONF, protocol: 'openai', model: 'gpt-5' }, client),
      { ...REQ, structured: { schema: { type: 'object' } } }, // gpt 系列 json_schema 档 → 有降级链可续跑
    )
    expect(calls).toBe(1) // 若续跑第二个参数面，「半截」会对消费者重复一遍
    expect(evs.filter((e) => e.type === 'text')).toEqual([{ type: 'text', delta: '半截' }])
    expect(evs.some((e) => e.type === 'error')).toBe(true)
  })

  it('usage-only chunk → done 带 usage（stream_options.include_usage）', async () => {
    const client = {
      chat: {
        completions: {
          // R31-1（三十一轮）：夹具补 finish_reason——真实 include_usage 流为
          // [内容…, finish chunk, usage-only chunk]；无 finish_reason 的形态按新契约
          // 归传输截断（见 r31a-openai-truncation.test.ts）
          create: fakeSend([
            { choices: [{ delta: { content: 'x' }, finish_reason: 'stop' }] },
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

  it('gpt 系列模型发 reasoning_effort（2026-08-14 定稿：全透传）', async () => {
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
    expect(captured?.['reasoning_effort']).toBe('xhigh')
    expect(captured?.['max_tokens']).toBeUndefined()
  })

  // RB-AI-P2-4：toolChoice='auto' 也关并行——对齐 anthropic 线（契约 W0：一轮最多一个工具调用）
  it("toolChoice='auto' 且 parallelControl → 发 parallel_tool_calls:false（W0 双协议对称）", async () => {
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
    await collect(createOpenAIProvider(conf, client), {
      ...REQ,
      toolChoice: 'auto',
      tools: [{ name: 'read_chapter', description: '读章', input_schema: { type: 'object', properties: {} } }],
    })
    expect(captured?.['parallel_tool_calls']).toBe(false)
    expect(captured?.['tool_choice']).toBe('auto')
  })

  it('无 toolChoice 时不发 parallel_tool_calls（未表达 W0 意图，不替调用方做主）', async () => {
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
    await collect(createOpenAIProvider(conf, client), {
      ...REQ,
      tools: [{ name: 'read_chapter', description: '读章', input_schema: { type: 'object', properties: {} } }],
    })
    expect('parallel_tool_calls' in (captured ?? {})).toBe(false)
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
      ragProviders: [],
      tiers: { creative: { model: '', effort: 'high' }, assistant: null, chat: null },
      revision: 0,
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
describe('OpenAI 适配器线格式分派（按 protocol）', () => {
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

// ── V-P2-9：anthropic 适配器 tool_choice 按表翻译（此前无视 toolChoiceMode 无条件发 type:'tool'）──

describe('Anthropic tool_choice 表驱动（V-P2-9）', () => {
  it('deepseek（required 模式）指名意图 → type:any（指名 type:tool 会 400）', async () => {
    let captured: Record<string, unknown> | null = null
    const client = {
      messages: {
        create: async (params: unknown) => {
          captured = params as Record<string, unknown>
          return (async function* () {
            yield { type: 'message_delta', usage: { input_tokens: 1, output_tokens: 1 }, delta: { stop_reason: 'end_turn' } }
          })()
        },
      },
    } as unknown as Anthropic
    await collect(
      createAnthropicProvider({ ...CONF, model: 'deepseek-v4-pro' } as ProviderConf, client),
      { ...REQ, toolChoice: 'tool', toolName: 'submit_chapter' },
    )
    expect(captured?.['tool_choice']).toEqual({ type: 'any' })
  })

  it('deepseek（required 模式）any 意图 → type:any；auto → type:auto', async () => {
    const results: unknown[] = []
    for (const toolChoice of ['any', 'auto'] as const) {
      const client = {
        messages: {
          create: async (params: unknown) => {
            results.push((params as Record<string, unknown>)['tool_choice'])
            return (async function* () {
              yield { type: 'message_delta', usage: { input_tokens: 1, output_tokens: 1 }, delta: { stop_reason: 'end_turn' } }
            })()
          },
        },
      } as unknown as Anthropic
      await collect(
        createAnthropicProvider({ ...CONF, model: 'deepseek-v4-pro' } as ProviderConf, client),
        { ...REQ, toolChoice },
      )
    }
    expect(results[0]).toEqual({ type: 'any' })
    expect(results[1]).toEqual({ type: 'auto' })
  })

  it('claude（named 模式）指名意图 → type:tool 原样（不降级）', async () => {
    let captured: Record<string, unknown> | null = null
    const client = {
      messages: {
        create: async (params: unknown) => {
          captured = params as Record<string, unknown>
          return (async function* () {
            yield { type: 'message_delta', usage: { input_tokens: 1, output_tokens: 1 }, delta: { stop_reason: 'end_turn' } }
          })()
        },
      },
    } as unknown as Anthropic
    await collect(
      createAnthropicProvider({ ...CONF, model: 'claude-sonnet-5' } as ProviderConf, client),
      { ...REQ, toolChoice: 'tool', toolName: 'submit_chapter' },
    )
    // claude 表项 parallelControl:true → 附带 disable_parallel_tool_use，断言取子集
    expect(captured?.['tool_choice']).toMatchObject({ type: 'tool', name: 'submit_chapter' })
  })
})

describe('D4 cache token 记账（三协议提取口径）', () => {
  it('Anthropic：message_start 捕获 cache 读/写量，message_delta 缺字段时兜底', async () => {
    const client = {
      messages: {
        create: fakeSend([
          // Anthropic 口径：input_tokens 不含 cache，cache_read/cache_creation 独立字段
          { type: 'message_start', message: { usage: { input_tokens: 100, cache_read_input_tokens: 60, cache_creation_input_tokens: 20 } } },
          { type: 'message_delta', usage: { output_tokens: 5 }, delta: { stop_reason: 'end_turn' } },
        ]),
      },
    } as unknown as Anthropic
    const evs = await collect(createAnthropicProvider(CONF, client), REQ)
    expect(evs.find((e) => e.type === 'done')).toMatchObject({
      type: 'done',
      usage: { inputTokens: 100, outputTokens: 5, cacheReadTokens: 60, cacheWriteTokens: 20 },
    })
  })

  it('Anthropic：message_delta 带 cache 字段时以其为准（终值优先）', async () => {
    const client = {
      messages: {
        create: fakeSend([
          { type: 'message_start', message: { usage: { input_tokens: 100, cache_read_input_tokens: 60, cache_creation_input_tokens: 20 } } },
          { type: 'message_delta', usage: { input_tokens: 100, output_tokens: 5, cache_read_input_tokens: 80, cache_creation_input_tokens: 20 }, delta: { stop_reason: 'end_turn' } },
        ]),
      },
    } as unknown as Anthropic
    const evs = await collect(createAnthropicProvider(CONF, client), REQ)
    expect(evs.find((e) => e.type === 'done')).toMatchObject({
      usage: { cacheReadTokens: 80, cacheWriteTokens: 20 },
    })
  })

  it('Anthropic：端点不发 cache 字段 → usage 无 cache 键（不造零值）', async () => {
    const client = {
      messages: {
        create: fakeSend([
          { type: 'message_start', message: { usage: { input_tokens: 10 } } },
          { type: 'message_delta', usage: { output_tokens: 2 }, delta: { stop_reason: 'end_turn' } },
        ]),
      },
    } as unknown as Anthropic
    const evs = await collect(createAnthropicProvider(CONF, client), REQ)
    const done = evs.find((e) => e.type === 'done')
    expect(done).toBeDefined()
    expect(done && 'cacheReadTokens' in done.usage).toBe(false)
  })

  it('OpenAI Chat：cached_tokens 归一——inputTokens 扣减已含的 cache 命中（M-1 勿双计成本）', async () => {
    const client = {
      chat: {
        completions: {
          create: fakeSend([
            { choices: [{ delta: { content: 'x' }, finish_reason: 'stop' }], usage: { prompt_tokens: 50, completion_tokens: 3, prompt_tokens_details: { cached_tokens: 40 } } },
          ]),
        },
      },
    } as unknown as OpenAI
    const evs = await collect(createOpenAIProvider({ ...CONF, protocol: 'openai' as const, auth: 'bearer' as const } as ProviderConf, client), REQ)
    // prompt_tokens 已含 cache 命中 → inputTokens=50-40=10（Anthropic 口径），cacheReadTokens 单列；
    // 修复前 inputTokens:50 + cacheReadTokens:40 双计（成本/预算口径虚高一个命中量）
    expect(evs.find((e) => e.type === 'done')).toMatchObject({
      usage: { inputTokens: 10, outputTokens: 3, cacheReadTokens: 40 },
    })
  })

  it('OpenAI Chat：choices[0].usage 双兜底路径同样提取 cache（Kimi 形态）', async () => {
    const client = {
      chat: {
        completions: {
          create: fakeSend([
            // usage 挂在 choices[0]（§4.4 Kimi 文档矛盾形态）
            { choices: [{ delta: { content: 'x' }, finish_reason: 'stop', usage: { prompt_tokens: 9, completion_tokens: 1, prompt_tokens_details: { cached_tokens: 7 } } }] },
          ]),
        },
      },
    } as unknown as OpenAI
    const evs = await collect(createOpenAIProvider({ ...CONF, protocol: 'openai' as const, auth: 'bearer' as const } as ProviderConf, client), REQ)
    expect(evs.find((e) => e.type === 'done')).toMatchObject({ usage: { cacheReadTokens: 7 } })
  })

  it('OpenAI Chat：流结束无 finish_reason 无 usage → 传输截断报错，不发 done{0,0}（R1 对齐）', async () => {
    const client = {
      chat: {
        completions: {
          // 非官方中转净空结束：有文本增量但既无 finish_reason 也无 usage chunk
          create: fakeSend([{ choices: [{ delta: { content: '半截' } }] }]),
        },
      },
    } as unknown as OpenAI
    const evs = await collect(createOpenAIProvider({ ...CONF, protocol: 'openai' as const, auth: 'bearer' as const } as ProviderConf, client), REQ)
    // 修复前：兜底 emitDone({0,0},'stop') → 真实计费调用按成功 0 成本入账
    expect(evs.find((e) => e.type === 'done')).toBeUndefined()
    expect(evs.find((e) => e.type === 'error')).toMatchObject({ type: 'error', retryable: true, code: 'NETWORK' })
  })

  it('OpenAI Chat：有 finish_reason 无 usage（include_usage 不兼容网关）→ 估计入账放行（R73-1）', async () => {
    const client = {
      chat: {
        completions: {
          create: fakeSend([{ choices: [{ delta: { content: '完整' }, finish_reason: 'stop' }] }]),
        },
      },
    } as unknown as OpenAI
    const evs = await collect(createOpenAIProvider({ ...CONF, protocol: 'openai' as const, auth: 'bearer' as const } as ProviderConf, client), REQ)
    // R73-1：网关完成但不回 usage——判错重试对这类网关是全量破坏，仍放行；但不再按
    // 0/0 入账（预算闸 tokens/cost 对该类端点永不生效）——input/output 按请求/产出
    // 字符折算（'hi' 与 '完整' 各 2 码位 × 0.6 → ceil = 2），estimated 标记估计口径
    expect(evs.find((e) => e.type === 'done')).toMatchObject({
      usage: { inputTokens: 2, outputTokens: 2, estimated: true },
      stopReason: 'stop',
    })
    expect(evs.find((e) => e.type === 'error')).toBeUndefined()
  })
})

// ── Responses 适配器（Responses 启用批 R1-R4，2026-08-17）──
// 被测契约：createOpenAIResponsesProvider(conf, client?, store?)，
// client 形状 { responses: { create } }；事件循环翻译 /v1/responses 流事件为 GenEvent。

/** Responses 协议 CONF（R1） */
const RCONF: ProviderConf = { ...CONF, protocol: 'openai-responses', model: 'gpt-5' }

/** 正常收尾的 completed 事件（output 含 message item → 非空产出 → done） */
function completedEvent(): unknown {
  return {
    type: 'response.completed',
    response: { output: [{ type: 'message' }], usage: { input_tokens: 1, output_tokens: 1 } },
  }
}

/** 假 Responses SDK 客户端：c.responses.create 形状（fakeSend 同款手法 + 入参捕获 + 按调用序可抛） */
function fakeResponsesClient(
  handle: (params: unknown, call: number) => unknown[],
): { client: OpenAI; params: Record<string, unknown>[] } {
  const params: Record<string, unknown>[] = []
  let call = 0
  const client = {
    responses: {
      create: async (p: unknown): Promise<AsyncGenerator<unknown>> => {
        call += 1
        params.push(p as Record<string, unknown>)
        const events = handle(p, call)
        return (async function* () {
          for (const e of events) yield e
        })()
      },
    },
  } as unknown as OpenAI
  return { client, params }
}

/** 最小空 store（降级记忆双写断言用，同 registry.test.ts emptyStore） */
function emptyResponsesStore(): ProviderStore {
  return {
    providers: [],
    currentId: null,
    currentModel: null,
    modelCaps: {},
    ragProviders: [],
    tiers: { creative: { model: '', effort: 'high' }, assistant: null, chat: null },
    revision: 0,
    vault: null,
    dek: null,
  }
}

describe('Responses 适配器（R1-R4）', () => {
  // T1 流只发 response.failed → terminal='failed'，error 取 response.error.message，不发 done
  it('T1 response.failed → error 含 boom，无 done', async () => {
    const { client } = fakeResponsesClient(() => [
      { type: 'response.failed', response: { error: { code: 'server_error', message: 'boom' } } },
    ])
    const evs = await collect(createOpenAIResponsesProvider(RCONF, client), REQ)
    const err = evs.find((e) => e.type === 'error')
    expect(err).toMatchObject({ type: 'error', retryable: false, code: 'PROTOCOL' })
    if (err && err.type === 'error') expect(err.message).toContain('boom')
    expect(evs.some((e) => e.type === 'done')).toBe(false)
  })

  // T1b（hh §八 条目 9）：流中 failed/error 裸 error 事件补 code——协议层无 status 可归因，
  // 与 toErrorEvent 兜底同码 PROTOCOL（failureAction 语义不变：retryable=false → author）
  it('T1b 流中 error 事件（网关 mid-stream）→ error 带 code PROTOCOL，无 done', async () => {
    const { client } = fakeResponsesClient(() => [
      { type: 'response.output_text.delta', delta: '部分产出' },
      { type: 'error', code: 'server_error', message: 'mid-stream boom' },
    ])
    const evs = await collect(createOpenAIResponsesProvider(RCONF, client), REQ)
    expect(evs.filter((e) => e.type === 'text')).toEqual([{ type: 'text', delta: '部分产出' }])
    expect(evs.find((e) => e.type === 'error')).toMatchObject({
      type: 'error',
      message: 'mid-stream boom',
      retryable: false,
      code: 'PROTOCOL',
    })
    expect(evs.some((e) => e.type === 'done')).toBe(false)
  })

  // T2 delta 后流自然结束（无 completed/incomplete/failed）→ 传输截断（retryable=true），不发 done
  it('T2 无终止事件流结束 → error「传输截断」retryable=true，无 done', async () => {
    const { client } = fakeResponsesClient(() => [{ type: 'response.output_text.delta', delta: 'hi' }])
    const evs = await collect(createOpenAIResponsesProvider(RCONF, client), REQ)
    expect(evs.filter((e) => e.type === 'text')).toEqual([{ type: 'text', delta: 'hi' }])
    const err = evs.find((e) => e.type === 'error')
    expect(err).toMatchObject({ type: 'error', retryable: true })
    if (err && err.type === 'error') expect(err.message).toContain('传输截断')
    expect(evs.some((e) => e.type === 'done')).toBe(false)
  })

  // T3 completed 但 response.output=[] → 空产出（retryable=false），不发 done
  it('T3 completed 空产出 → error 含「空产出」，无 done', async () => {
    const { client } = fakeResponsesClient(() => [
      { type: 'response.completed', response: { output: [], usage: { input_tokens: 1, output_tokens: 1 } } },
    ])
    const evs = await collect(createOpenAIResponsesProvider(RCONF, client), REQ)
    const err = evs.find((e) => e.type === 'error')
    expect(err).toMatchObject({ type: 'error', retryable: false })
    if (err && err.type === 'error') expect(err.message).toContain('空产出')
    expect(evs.some((e) => e.type === 'done')).toBe(false)
  })

  // T4 incomplete 且 reason 非 max_output_tokens → error 含该 reason，不发 done
  it('T4 incomplete content_filter → error 含 content_filter，无 done', async () => {
    const { client } = fakeResponsesClient(() => [
      {
        type: 'response.incomplete',
        response: {
          status: 'incomplete',
          incomplete_details: { reason: 'content_filter' },
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      },
    ])
    const evs = await collect(createOpenAIResponsesProvider(RCONF, client), REQ)
    const err = evs.find((e) => e.type === 'error')
    expect(err).toBeDefined()
    if (err && err.type === 'error') expect(err.message).toContain('content_filter')
    expect(evs.some((e) => e.type === 'done')).toBe(false)
  })

  // T5 reasoning_text / reasoning_summary_text 双事件流 → reasoning 事件拼装
  it('T5 reasoning_text + reasoning_summary_text delta → reasoning 事件', async () => {
    const { client } = fakeResponsesClient(() => [
      { type: 'response.reasoning_text.delta', delta: '思考' },
      { type: 'response.reasoning_summary_text.delta', delta: '摘要' },
      completedEvent(),
    ])
    const evs = await collect(createOpenAIResponsesProvider(RCONF, client), REQ)
    expect(evs.filter((e) => e.type === 'reasoning')).toEqual([
      { type: 'reasoning', delta: '思考' },
      { type: 'reasoning', delta: '摘要' },
    ])
    expect(evs.some((e) => e.type === 'done')).toBe(true)
  })

  // T6 gpt-5 参数面：reasoning:{effort} / store:false / include encrypted / parallel_tool_calls:false
  it('T6 gpt-5 + effort + tools → reasoning.effort / store:false / include / parallel_tool_calls:false', async () => {
    const { client, params } = fakeResponsesClient(() => [completedEvent()])
    await collect(createOpenAIResponsesProvider(RCONF, client), {
      ...REQ,
      effort: 'high',
      toolChoice: 'auto',
      tools: [{ name: 'read_chapter', description: '读章', input_schema: { type: 'object', properties: {} } }],
    })
    const p = params[0]!
    expect(p).toMatchObject({ model: 'gpt-5', stream: true })
    expect(p['reasoning']).toEqual({ effort: 'high' })
    expect(p['store']).toBe(false)
    expect(p['include'] as string[]).toContain('reasoning.encrypted_content')
    expect(p['parallel_tool_calls']).toBe(false)
  })

  // T7 grok：effort → 顶层 reasoning_effort（effortWire 'reasoning_effort'，不嵌 reasoning 对象）
  it('T7 grok-4 effort → 顶层 reasoning_effort', async () => {
    const { client, params } = fakeResponsesClient(() => [completedEvent()])
    await collect(createOpenAIResponsesProvider({ ...RCONF, model: 'grok-4' }, client), { ...REQ, effort: 'high' })
    const p = params[0]!
    expect(p['reasoning_effort']).toBe('high')
    expect('reasoning' in p).toBe(false)
  })

  // T8 deepseek：effortWire 'output_config' + 基表档位收敛（medium→high）；json_object 不发 text.format
  it('T8 deepseek-v4 effort:medium → output_config:{effort:"high"}，不发 text', async () => {
    const { client, params } = fakeResponsesClient(() => [completedEvent()])
    await collect(createOpenAIResponsesProvider({ ...RCONF, model: 'deepseek-v4' }, client), {
      ...REQ,
      effort: 'medium',
      structured: { schema: { type: 'object' } },
    })
    const p = params[0]!
    expect(p['output_config']).toEqual({ effort: 'high' })
    expect('text' in p).toBe(false)
  })

  // T9 tool_choice 表驱动翻译：named（gpt）any→required / tool→指名对象；required（deepseek）tool→required
  it('T9 tool_choice：gpt any→required / tool→指名；deepseek tool→required', async () => {
    const mk = async (model: string, toolChoice: 'any' | 'tool', toolName?: string): Promise<unknown> => {
      const { client, params } = fakeResponsesClient(() => [completedEvent()])
      await collect(
        createOpenAIResponsesProvider({ ...RCONF, model }, client),
        {
          ...REQ,
          toolChoice,
          ...(toolName ? { toolName } : {}),
          tools: [{ name: 'submit_chapter', description: '交章', input_schema: { type: 'object', properties: {} } }],
        },
      )
      return params[0]!['tool_choice']
    }
    expect(await mk('gpt-5', 'any')).toBe('required')
    expect(await mk('gpt-5', 'tool', 'submit_chapter')).toEqual({ type: 'function', name: 'submit_chapter' })
    expect(await mk('deepseek-v4', 'tool', 'submit_chapter')).toBe('required')
  })

  // T10 多轮回插：gpt（echoReasoning encrypted）回插加密 reasoning item 且先于 function_call；grok（strip）剥除
  it('T10 assistant reasoning 块：gpt 回插（先于 function_call）/ grok 剥除', async () => {
    const req: GenRequest = {
      systemPrompt: '',
      messages: [
        {
          role: 'assistant',
          content: [
            { type: 'text', text: '回答' },
            { type: 'reasoning', text: '推理', encrypted: 'ENC', itemId: 'rs_1' },
            { type: 'tool_use', id: 'c1', name: 'submit', input: { a: 1 } },
          ],
        },
      ],
    }
    const mkInput = async (model: string): Promise<Record<string, unknown>[]> => {
      const { client, params } = fakeResponsesClient(() => [completedEvent()])
      await collect(createOpenAIResponsesProvider({ ...RCONF, model }, client), req)
      return params[0]!['input'] as Record<string, unknown>[]
    }

    const gptInput = await mkInput('gpt-5')
    const rsIdx = gptInput.findIndex((i) => i['type'] === 'reasoning')
    expect(rsIdx).toBeGreaterThanOrEqual(0)
    expect(gptInput[rsIdx]).toEqual({ type: 'reasoning', id: 'rs_1', encrypted_content: 'ENC', summary: [] })
    const fcIdx = gptInput.findIndex((i) => i['type'] === 'function_call')
    expect(fcIdx).toBeGreaterThan(rsIdx)
    expect(gptInput[fcIdx]).toMatchObject({ type: 'function_call', name: 'submit' })

    const grokInput = await mkInput('grok-4')
    expect(grokInput.some((i) => i['type'] === 'reasoning')).toBe(false)
    expect(grokInput.some((i) => i['type'] === 'function_call')).toBe(true)
  })

  // T11 output_item.done(reasoning, encrypted_content) → reasoning_item 事件（缺口 11）
  it('T11 reasoning item done 带 encrypted_content → reasoning_item 事件', async () => {
    const { client } = fakeResponsesClient(() => [
      { type: 'response.output_item.done', item: { type: 'reasoning', id: 'rs_9', encrypted_content: 'ENC9' } },
      completedEvent(),
    ])
    const evs = await collect(createOpenAIResponsesProvider(RCONF, client), REQ)
    expect(evs.find((e) => e.type === 'reasoning_item')).toEqual({
      type: 'reasoning_item',
      encrypted: 'ENC9',
      itemId: 'rs_9',
    })
  })

  // T12 usage 四分量：input/output + cached_tokens → cacheReadTokens + reasoning_tokens → reasoningTokens
  // M-1：input_tokens 已含 cached → inputTokens=10-5=5（归一 Anthropic 口径，勿双计成本）
  it('T12 completed usage → inputTokens=5（扣 cache）/ cacheReadTokens=5 / reasoningTokens=7', async () => {
    const { client } = fakeResponsesClient(() => [
      {
        type: 'response.completed',
        response: {
          output: [{ type: 'message' }],
          usage: {
            input_tokens: 10,
            output_tokens: 20,
            input_tokens_details: { cached_tokens: 5 },
            output_tokens_details: { reasoning_tokens: 7 },
          },
        },
      },
    ])
    const evs = await collect(createOpenAIResponsesProvider(RCONF, client), REQ)
    expect(evs.find((e) => e.type === 'done')).toMatchObject({
      type: 'done',
      usage: { inputTokens: 5, outputTokens: 20, cacheReadTokens: 5, reasoningTokens: 7 },
    })
  })

  // T13 structured 首发 400（照 OpenAI 适配器 400 降级链）→ 剥 structured 重试成功 + 降级记忆双写
  it('T13 结构化首发 400 → 第二次 create 无 text 键且流正常完成', async () => {
    const { client, params } = fakeResponsesClient((_p, call) => {
      if (call === 1) {
        throw new OpenAI.APIError(400, { type: 'error', message: 'bad request' }, 'bad request', undefined)
      }
      return [
        { type: 'response.output_text.delta', delta: 'ok' },
        completedEvent(),
      ]
    })
    const store = emptyResponsesStore()
    const evs = await collect(
      createOpenAIResponsesProvider(RCONF, client, store),
      { ...REQ, structured: { schema: { type: 'object' } } },
    )
    expect(params).toHaveLength(2)
    expect('text' in params[0]!).toBe(true) // 首发 gpt（json_schema 档）带 text.format
    expect('text' in params[1]!).toBe(false) // 降级剥除 structured
    expect(evs.some((e) => e.type === 'text')).toBe(true)
    expect(evs.some((e) => e.type === 'done')).toBe(true)
    expect(evs.some((e) => e.type === 'error')).toBe(false)
    // 降级记忆（persistDegraded + store.modelCaps 双写，照 anthropic 适配器）
    expect(store.modelCaps['t1/gpt-5']).toEqual({ structured: false })
  })

  // ii-1：首个 attempt 已消费流（已 yield 文本）后中途 400 —— 不换参数面重跑（防重复增量），直接终态错误
  it('ii-1 流中 400 不降级重跑（已消费 → 终态错误，无重复增量）', async () => {
    let calls = 0
    const client = {
      responses: {
        create: async (): Promise<AsyncGenerator<unknown>> => {
          calls += 1
          return (async function* () {
            yield { type: 'response.output_text.delta', delta: '半截' }
            throw new OpenAI.APIError(400, { type: 'error', message: 'mid-stream bad request' }, 'bad request', undefined)
          })()
        },
      },
    } as unknown as OpenAI
    const evs = await collect(
      createOpenAIResponsesProvider(RCONF, client),
      { ...REQ, structured: { schema: { type: 'object' } } }, // gpt 档有降级链可续跑
    )
    expect(calls).toBe(1) // 若续跑第二个参数面，「半截」会对消费者重复一遍
    expect(evs.filter((e) => e.type === 'text')).toEqual([{ type: 'text', delta: '半截' }])
    expect(evs.some((e) => e.type === 'error')).toBe(true)
  })

  // T14 gen 层意图翻译（缺口 5）：generateTool requireTool 按 toolChoiceMode 翻译（fake provider 不走 HTTP）
  it("T14 generateTool requireTool：gpt-5 → req.toolChoice='tool'；deepseek-v4 → 'any'", async () => {
    const capture = (model: string): { provider: ModelProvider; seen: GenRequest[] } => {
      const seen: GenRequest[] = []
      const provider: ModelProvider = {
        conf: { ...RCONF, model },
        stream: (req: GenRequest) => {
          seen.push(req)
          return (async function* (): AsyncGenerator<GenEvent> {
            yield { type: 'tool', id: 'c1', name: 'submit_chapter', input: { ok: true } }
            yield { type: 'done', usage: { inputTokens: 1, outputTokens: 1 }, stopReason: 'tool_use' }
          })()
        },
      }
      return { provider, seen }
    }
    const gpt = capture('gpt-5')
    await generateTool(gpt.provider, { ...REQ, requireTool: true, toolName: 'submit_chapter' }, new AbortController().signal)
    expect(gpt.seen[0]?.toolChoice).toBe('tool')

    const ds = capture('deepseek-v4')
    await generateTool(ds.provider, { ...REQ, requireTool: true, toolName: 'submit_chapter' }, new AbortController().signal)
    expect(ds.seen[0]?.toolChoice).toBe('any')
  })

  // T15 正常路径：output_text.delta + completed（非空 output）→ done stopReason 'stop'
  it('T15 正常流 → done stopReason stop', async () => {
    const { client } = fakeResponsesClient(() => [
      { type: 'response.output_text.delta', delta: 'ok' },
      completedEvent(),
    ])
    const evs = await collect(createOpenAIResponsesProvider(RCONF, client), REQ)
    expect(evs.filter((e) => e.type === 'text')).toEqual([{ type: 'text', delta: 'ok' }])
    expect(evs.some((e) => e.type === 'error')).toBe(false)
    expect(evs.find((e) => e.type === 'done')).toMatchObject({ type: 'done', stopReason: 'stop' })
  })

  // R65-10（总六十五轮）：function_call_arguments.delta 缺 item_id（与 R65-9 同族）——
  // 旧实现并入同一空键，两调用的参数串拼且 done 认领不到（全丢）；改自增兜底键 +
  // FIFO 队列后，done 按流式序认领各自的参数
  it('R65-10: 两条缺 item_id 的 function_call delta → 聚合出两个独立调用（参数不串拼）', async () => {
    const fcDone = (id: string, callId: string, name: string): unknown => ({
      type: 'response.output_item.done',
      item: { type: 'function_call', id, call_id: callId, name, arguments: '' },
    })
    const { client } = fakeResponsesClient(() => [
      // call_1 的参数分两片（缺 item_id）——续片归并最近兜底键
      { type: 'response.function_call_arguments.delta', delta: '{"a":' },
      { type: 'response.function_call_arguments.delta', delta: '1}' },
      fcDone('fc_1', 'call_1', 'toolA'),
      // call_2 的参数单片（缺 item_id）——done 后另开兜底键
      { type: 'response.function_call_arguments.delta', delta: '{"b":2}' },
      fcDone('fc_2', 'call_2', 'toolB'),
      {
        type: 'response.completed',
        response: { output: [{ type: 'function_call' }, { type: 'function_call' }], usage: { input_tokens: 1, output_tokens: 1 } },
      },
    ])
    const evs = await collect(createOpenAIResponsesProvider(RCONF, client), REQ)
    const tools = evs.filter((e) => e.type === 'tool')
    expect(tools).toHaveLength(2) // 旧实现：done 认领不到空键累积 → 两调用参数全丢（input={}）
    expect(tools[0]).toMatchObject({ id: 'call_1', name: 'toolA', input: { a: 1 } })
    expect(tools[1]).toMatchObject({ id: 'call_2', name: 'toolB', input: { b: 2 } })
  })
})

// ── A3（五十九轮）：降级记忆命中首发即剥 structured 成功 → done 带 degraded ─────────
// 修复背景：degraded 判据原为 attempt !== attempts[0]，记忆命中时首发即剥除参数面，
// 判据恒 false——Z-12 重放口径缺口在记忆命中路径（常态）全部漏标；改判 attempt !==
// plan.original 后，记忆命中的首发成功同样标 degraded。

describe('A3（五十九轮）：记忆命中首发剥除成功 → done 带 degraded', () => {
  it('anthropic：记忆命中 → 首发即剥 structured 且成功 → done.degraded = true', async () => {
    const client = {
      messages: {
        create: async () =>
          (async function* () {
            yield { type: 'message_delta', usage: { input_tokens: 1, output_tokens: 1 }, delta: { stop_reason: 'end_turn' } }
          })(),
      },
    } as unknown as Anthropic
    const store: ProviderStore = {
      providers: [],
      currentId: null,
      currentModel: null,
      modelCaps: { 't1/claude-sonnet-5': { structured: false } },
      ragProviders: [],
      tiers: { creative: { model: '', effort: 'high' }, assistant: null, chat: null },
      revision: 0,
      vault: null,
      dek: null,
    }
    const prov = createAnthropicProvider({ ...CONF, model: 'claude-sonnet-5' } as ProviderConf, client, store)
    const evs = await collect(prov, { ...REQ, structured: { schema: {} } })
    const done = evs.find((e) => e.type === 'done') as { degraded?: boolean } | undefined
    expect(done).toBeDefined()
    expect(done!.degraded).toBe(true)
  })

  it('无记忆首发原样成功（attempt === original）→ done 不带 degraded（口径不泛化）', async () => {
    const client = {
      messages: {
        create: async () =>
          (async function* () {
            yield { type: 'message_delta', usage: { input_tokens: 1, output_tokens: 1 }, delta: { stop_reason: 'end_turn' } }
          })(),
      },
    } as unknown as Anthropic
    const prov = createAnthropicProvider({ ...CONF, model: 'claude-sonnet-5' } as ProviderConf, client)
    const evs = await collect(prov, { ...REQ, structured: { schema: {} } })
    const done = evs.find((e) => e.type === 'done') as { degraded?: boolean } | undefined
    expect(done).toBeDefined()
    expect(done!.degraded).toBeUndefined()
  })
})
