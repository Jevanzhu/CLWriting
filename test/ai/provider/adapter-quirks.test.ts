/**
 * 适配器参数面 quirks 单测（R0916-5b 拆分件，2026-09-16）。
 *
 * 拆分来源：test/ai/provider/adapter.test.ts（原「双协议适配器单测」，原头注沿革
 * 见残核 adapter.test.ts）——本件承接按模型家族的参数面 / wire 翻译域：「批次3 quirks
 * 参数面（方案 §6）」「Grok 工具整块 chunk（方案 §6：流式 tool_calls 单 chunk 不分片）」
 * 「批次2 reasoning 思维链（方案 §4.2）」「Anthropic tool_choice 表驱动（V-P2-9）」
 * 四 describe 连同其域前导注记整块搬移零改动。
 */
import { describe, expect, it } from 'vitest'
import Anthropic from '@anthropic-ai/sdk'
import OpenAI from 'openai'
import { createAnthropicProvider } from '../../../src/ai/provider/anthropic-adapter.js'
import { createOpenAIProviderChat } from '../../../src/ai/provider/openai-adapter.js'
import type { GenRequest, ProviderConf } from '../../../src/ai/provider/index.js'
import { CONF, REQ, collect, fakeSend } from './adapter-fixtures.js'

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
    await collect(createOpenAIProviderChat(conf, client), { ...REQ, maxTokens: 100 })
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
    await collect(createOpenAIProviderChat(conf, client), { ...REQ, maxTokens: 100 })
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
    const evs = await collect(createOpenAIProviderChat(CONF, client), REQ)
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
    const evs = await collect(createOpenAIProviderChat(conf, client), REQ)
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
    const evs = await collect(createOpenAIProviderChat(CONF, client), REQ)
    expect(evs.filter((e) => e.type === 'reasoning')).toEqual([{ type: 'reasoning', delta: '思考中…' }])
  })

  it('chat 适配器：assistant 消息的 reasoning 块 → 写回 reasoning_content 字段（echoReasoning=true 族）', async () => {
    // R40-2（四十轮）：回写档位化后本用例改钉 deepseek 族（echoReasoning=true）——
    // 原 CONF 'test-model' 属 unknown 族（false），旧断言锚的是无条件回写行为
    const conf = { ...CONF, model: 'deepseek-chat' } as ProviderConf
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
    await collect(createOpenAIProviderChat(conf, client), req)
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
