/**
 * OpenAI 协议适配器单测（R0916-5b 拆分件，2026-09-16）。
 *
 * 拆分来源：test/ai/provider/adapter.test.ts（原「双协议适配器单测」，原头注沿革
 * 见残核 adapter.test.ts）——本件承接 OpenAI chat-completions 协议线：「OpenAI 适配器」
 * 与「OpenAI 适配器线格式分派（按 protocol）」两 describe 整块搬移零改动（流事件
 * 翻译 / tool_calls index 聚合 / usage 提取 / 参数面透传 / 线格式分派域）。
 */
import { describe, expect, it } from 'vitest'
import OpenAI from 'openai'
import { createOpenAIProviderChat } from '../../../src/ai/provider/openai-adapter.js'
import type { ProviderConf } from '../../../src/ai/provider/index.js'
import { CONF, REQ, collect, fakeSend } from './adapter-fixtures.js'

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
    const evs = await collect(createOpenAIProviderChat(CONF, client), REQ)
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
    const evs = await collect(createOpenAIProviderChat(CONF, client), REQ)
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
    const evs = await collect(createOpenAIProviderChat(CONF, client), REQ)
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
    const evs = await collect(createOpenAIProviderChat(CONF, client), REQ)
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
      createOpenAIProviderChat({ ...CONF, protocol: 'openai', model: 'gpt-5' }, client),
      { ...REQ, structured: { schema: { type: 'object' } } }, // gpt 系列 json_schema 档 → 有降级链可续跑
    )
    expect(calls).toBe(1) // 若续跑第二个参数面，「半截」会对消费者重复一遍
    expect(evs.filter((e) => e.type === 'text')).toEqual([{ type: 'text', delta: '半截' }])
    expect(evs.some((e) => e.type === 'error')).toBe(true)
  })

  it('usage-only chunk（无 finish_reason）→ 截断错误不发 done（R33-3：usage 不充当完成证据；对齐 dev 侧 R31-1 契约）', async () => {
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
    const evs = await collect(createOpenAIProviderChat(CONF, client), REQ)
    // 旧契约：usage 在场即按 done 收口（截断流被伪装成功）；R33-3 收窄——
    // usage-only chunk 只证明计费上报过，无 finish_reason 仍按 R1 传输截断报错
    //（夹具注：无 finish_reason 的「合规 include_usage」对照组见下一条用例；dev 线
    // r31a-openai-truncation.test.ts 为同契约独立锚定。）
    expect(evs.find((e) => e.type === 'done')).toBeUndefined()
    expect(evs.find((e) => e.type === 'error')).toMatchObject({ retryable: true, code: 'NETWORK' })
  })

  it('合规 include_usage（finish_reason 先到，usage-only 垫后）→ done 带实测 usage', async () => {
    const client = {
      chat: {
        completions: {
          create: fakeSend([
            { choices: [{ delta: { content: 'x' }, finish_reason: 'stop' }] },
            { choices: [], usage: { prompt_tokens: 8, completion_tokens: 4 } },
          ]),
        },
      },
    } as unknown as OpenAI
    const evs = await collect(createOpenAIProviderChat(CONF, client), REQ)
    expect(evs.find((e) => e.type === 'done')).toMatchObject({ type: 'done', usage: { inputTokens: 8, outputTokens: 4 } })
  })

  // 五轮重评修复批（C101）：usage 随先行 content chunk 到（choice 在、finish_reason 不在）、
  // 末 chunk 只带 finish_reason 不重复携带 → 实测 usage 不得被静默丢弃（原实现只在
  // usage-only 与 finish_reason 两 chunk 落账，此形态降级估计入账 estimated:true）
  it('usage 先行挂 content chunk、finish chunk 不重复携带 → done 带实测 usage（C101）', async () => {
    const client = {
      chat: {
        completions: {
          create: fakeSend([
            { choices: [{ delta: { content: 'x' }, finish_reason: null }], usage: { prompt_tokens: 7, completion_tokens: 3 } },
            { choices: [{ delta: {}, finish_reason: 'stop' }] },
          ]),
        },
      },
    } as unknown as OpenAI
    const evs = await collect(createOpenAIProviderChat(CONF, client), REQ)
    const done = evs.find((e) => e.type === 'done')
    expect(done).toMatchObject({ type: 'done', usage: { inputTokens: 7, outputTokens: 3 } })
    expect((done as { usage: { estimated?: boolean } }).usage.estimated, '实测计量不得降级估计口径').toBeUndefined()
  })

  it('APIError 5xx → error 事件 retryable=true；message 带脱敏状态码', async () => {
    const err = new OpenAI.APIError(500, { type: 'error', message: 'server meltdown' }, 'server meltdown', undefined)
    const client = { chat: { completions: { create: () => Promise.reject(err) } } } as unknown as OpenAI
    const evs = await collect(createOpenAIProviderChat(CONF, client), REQ)
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
    await collect(createOpenAIProviderChat(conf, client), REQ)
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
    await collect(createOpenAIProviderChat(conf, client), { ...REQ, effort: 'high' })
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
    await collect(createOpenAIProviderChat(conf, client), { ...REQ, effort: 'xhigh' })
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
    await collect(createOpenAIProviderChat(conf, client), {
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
    await collect(createOpenAIProviderChat(conf, client), {
      ...REQ,
      tools: [{ name: 'read_chapter', description: '读章', input_schema: { type: 'object', properties: {} } }],
    })
    expect('parallel_tool_calls' in (captured ?? {})).toBe(false)
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
