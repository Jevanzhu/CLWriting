/**
 * R36 第三十六轮评审修复批 A（AI 链路 + RAG）provider 线回归：
 *
 * - R36-2（P2，保守路径 + 流侧半主路径）：Anthropic 扩展思考块零回传的防御类修复——
 *   a. claude 原生 + effort 组合显式禁思考（thinking:{type:'disabled'}），防多轮工具链
 *      400（Anthropic 要求思考+工具必须回传带签名块；签名载道受类型扩展击穿
 *      usage-estimate 所限，见 anthropic-adapter toParams/toAnthropicMessage 注）；
 *      deepseek 的 anthropic 端点（同为 output_config wire）不禁（无 thinking 参数语义）。
 *   b. 流侧 thinking_delta/signature_delta/redacted_thinking 不再全弃——thinking 文本
 *      以 reasoning 事件透出（三线口径对齐 openai reasoning_content / responses
 *      reasoning_text），并计入 R73-1 产出累计（思考 token 也是真实计费面）。
 * - R36-14（P3）：openai 线 usage:{} 空对象不再按 0/0 入账——等价「无 usage」走
 *   R73-1 估计兜底（isRealUsage 闸 + 末见 wins 不被空对象覆盖）。
 * - R36-15（P3）：responses 线兜底 tool id 从 map.size（非单调，同流可重复）改为
 *   流级单调计数 fallbackToolSeq（对齐 openai 线 call_N 口径）。
 */
import { describe, expect, it } from 'vitest'
import Anthropic from '@anthropic-ai/sdk'
import OpenAI from 'openai'
import { createAnthropicProvider } from '../../../src/ai/provider/anthropic-adapter.js'
import { createOpenAIProvider } from '../../../src/ai/provider/openai-adapter.js'
import { createOpenAIResponsesProvider } from '../../../src/ai/provider/responses-adapter.js'
import { estimateInputTokens, estimateOutputTokens } from '../../../src/ai/provider/usage-estimate.js'
import type { GenEvent, GenRequest, ModelProvider, ProviderConf } from '../../../src/ai/provider/index.js'

const CONF = {
  id: 't1',
  name: 't',
  protocol: 'openai' as const,
  auth: 'bearer' as const,
  baseUrl: 'https://example.local',
  model: 'custom-gateway-model',
  apiKey: 'sk-secret-key',
  caps: null,
} as ProviderConf

const ANTH_CONF = {
  id: 't-anth',
  name: 't',
  protocol: 'anthropic' as const,
  auth: 'anthropic' as const,
  baseUrl: 'https://api.anthropic.com',
  model: 'claude-sonnet-5',
  apiKey: 'sk-ant-secret',
  caps: null,
} as ProviderConf

/** 伪网关流：客户端返回 async generator（r35-batch-a.test.ts 同款手法） */
function fakeSend(events: unknown[]): () => AsyncGenerator<unknown> {
  return async function* () {
    for (const e of events) yield e
  }
}

async function collect(prov: ModelProvider, req: GenRequest): Promise<GenEvent[]> {
  const out: GenEvent[] = []
  for await (const ev of prov.stream(req, new AbortController().signal)) out.push(ev)
  return out
}

describe('R36-2: Anthropic 流侧思考增量透出 + claude+effort 显式禁思考', () => {
  it('流含 thinking_delta + signature_delta + tool_use → reasoning 事件透出、工具正常、无 usage 估计含思考文本', async () => {
    const client = {
      messages: {
        create: fakeSend([
          { type: 'message_start', message: { usage: { input_tokens: 10 } } },
          { type: 'content_block_start', index: 0, content_block: { type: 'thinking' } },
          { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: '先思考一下' } },
          { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: '，再展开' } },
          { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig-abc123' } },
          { type: 'content_block_stop', index: 0 },
          { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_01', name: 'submit_chapter' } },
          { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"chapter":1}' } },
          { type: 'content_block_stop', index: 1 },
          { type: 'message_delta', delta: { stop_reason: 'tool_use' } },
        ]),
      },
    } as unknown as Anthropic
    const req: GenRequest = {
      systemPrompt: '',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [{ name: 'submit_chapter', description: 'd', input_schema: { type: 'object', properties: {} } }],
      effort: 'xhigh',
    }
    const evs = await collect(createAnthropicProvider(ANTH_CONF, client), req)
    // 修复前：thinking/signature 全弃，思考文本无感（无 reasoning 事件）
    const reasoning = evs.filter((e): e is { type: 'reasoning'; delta: string } => e.type === 'reasoning')
    expect(reasoning.map((e) => e.delta)).toEqual(['先思考一下', '，再展开'])
    // 工具链不受影响
    const tool = evs.find((e) => e.type === 'tool')
    expect(tool).toMatchObject({ type: 'tool', id: 'toolu_01', name: 'submit_chapter' })
    // 无 usage → R73-1 估计兜底：input 用 message_start 实测（10），output 含思考文本 + tool 参数
    const done = evs.find((e) => e.type === 'done')
    expect(done).toBeDefined()
    if (done?.type !== 'done') return
    expect(done.usage).toEqual({
      inputTokens: 10,
      outputTokens: estimateOutputTokens('先思考一下，再展开submit_chapter{"chapter":1}', ANTH_CONF.model),
      estimated: true,
    })
  })

  it('流含 redacted_thinking 块（data 整体下发）→ 不崩、正文与 usage 正常', async () => {
    const client = {
      messages: {
        create: fakeSend([
          { type: 'content_block_start', index: 0, content_block: { type: 'redacted_thinking', data: 'base64-encrypted-data' } },
          { type: 'content_block_stop', index: 0 },
          { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
          { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: '正文产出' } },
          { type: 'content_block_stop', index: 1 },
          { type: 'message_delta', usage: { input_tokens: 3, output_tokens: 4 }, delta: { stop_reason: 'end_turn' } },
        ]),
      },
    } as unknown as Anthropic
    const evs = await collect(createAnthropicProvider(ANTH_CONF, client), {
      systemPrompt: '',
      messages: [{ role: 'user', content: 'hi' }],
      effort: 'xhigh',
    })
    expect(evs.some((e) => e.type === 'reasoning')).toBe(false) // 密文块无文本可透出
    expect(evs.find((e) => e.type === 'text')).toMatchObject({ type: 'text', delta: '正文产出' })
    const done = evs.find((e) => e.type === 'done')
    expect(done).toMatchObject({ type: 'done', usage: { inputTokens: 3, outputTokens: 4 } })
  })

  it('claude 原生 + effort → 请求含 thinking:{type:"disabled"}（显式禁思考防多轮 400）', async () => {
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
    await collect(createAnthropicProvider(ANTH_CONF, client), {
      systemPrompt: '',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [{ name: 't', description: 'd', input_schema: { type: 'object', properties: {} } }],
      effort: 'xhigh',
    })
    expect(captured).not.toBeNull()
    expect(captured!['thinking']).toEqual({ type: 'disabled' })
    expect(captured!['output_config']).toEqual({ effort: 'xhigh' })
  })

  it('deepseek 的 anthropic 端点同走 output_config wire 但不禁思考（无 thinking 参数语义）', async () => {
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
    await collect(createAnthropicProvider({ ...ANTH_CONF, model: 'deepseek-chat' } as ProviderConf, client), {
      systemPrompt: '',
      messages: [{ role: 'user', content: 'hi' }],
      effort: 'xhigh',
    })
    expect(captured!['output_config']).toBeDefined()
    expect('thinking' in (captured ?? {})).toBe(false)
  })

  it('claude 原生无 effort → 不发 thinking 参数（不禁思考，行为与修复前一致）', async () => {
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
    await collect(createAnthropicProvider(ANTH_CONF, client), {
      systemPrompt: '',
      messages: [{ role: 'user', content: 'hi' }],
    })
    expect('output_config' in (captured ?? {})).toBe(false)
    expect('thinking' in (captured ?? {})).toBe(false)
  })

  it('回传侧：text+reasoning assistant 消息 reasoning 块仍静默丢弃（次防线不回归），请求消息无空壳', async () => {
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
    await collect(createAnthropicProvider(ANTH_CONF, client), {
      systemPrompt: '',
      messages: [
        { role: 'user', content: '帮我看第二章' },
        {
          role: 'assistant',
          content: [
            { type: 'text', text: '我来调用工具。' },
            { type: 'reasoning', text: '（思考：需要读章）' }, // 旧回传推理文本 → 丢弃（次防线）
            { type: 'tool_use', id: 'toolu_01', name: 'read_chapter', input: { chapter: 2 } },
          ],
        },
        { role: 'user', content: [{ type: 'tool_result', toolUseId: 'toolu_01', content: '正文…' }] },
      ],
      tools: [{ name: 'read_chapter', description: 'd', input_schema: { type: 'object', properties: {} } }],
      effort: 'xhigh',
    })
    const messages = (captured!['messages'] as Record<string, unknown>[])
    const asst = messages.find((m) => m['role'] === 'assistant')
    expect(asst).toBeDefined()
    // reasoning 块剥除后：content = [text, tool_use]，无思考块也无空壳
    const content = asst!['content'] as Record<string, unknown>[]
    expect(content.map((b) => b['type'])).toEqual(['text', 'tool_use'])
  })
})

describe('R36-14: openai 线 usage:{} 空对象走 R73-1 估计兜底（不入 0/0 账）', () => {
  it('finish_reason + 空 usage 对象 → done 按估计兜底入账（estimated 标真）', async () => {
    const client = {
      chat: {
        completions: {
          create: fakeSend([
            { choices: [{ index: 0, delta: { content: '正文' }, finish_reason: null }] },
            { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
            { choices: [], usage: {} }, // 空对象：修复前按 0/0 入账，绕过 R73-1
          ]),
        },
      },
    } as unknown as OpenAI
    const req: GenRequest = { systemPrompt: '', messages: [{ role: 'user', content: 'hi' }] }
    const evs = await collect(createOpenAIProvider(CONF, client), req)
    const done = evs.find((e) => e.type === 'done')
    expect(done).toBeDefined()
    if (done?.type !== 'done') return
    // 空 usage = 无 usage → 与 responses/anthropic 线同口径：R73-1 估计（estimated 标记）
    expect(done.usage).toEqual({
      inputTokens: estimateInputTokens(req, CONF.model),
      outputTokens: estimateOutputTokens('正文', CONF.model),
      estimated: true,
    })
  })

  it('真实 usage 之后再来空对象 → 末见 wins 不被空对象覆盖', async () => {
    const client = {
      chat: {
        completions: {
          create: fakeSend([
            { choices: [{ index: 0, delta: { content: '正文' }, finish_reason: null }] },
            { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 12, completion_tokens: 7 } },
            { choices: [], usage: {} }, // 修复前：latestUsage 被 {} 覆盖 → done 0/0
          ]),
        },
      },
    } as unknown as OpenAI
    const evs = await collect(createOpenAIProvider(CONF, client), {
      systemPrompt: '',
      messages: [{ role: 'user', content: 'hi' }],
    })
    const done = evs.find((e) => e.type === 'done')
    expect(done).toMatchObject({ type: 'done', usage: { inputTokens: 12, outputTokens: 7 } })
    if (done?.type !== 'done') return
    expect(done.usage.estimated).toBeUndefined()
  })
})

describe('R36-15: responses 线兜底 tool id 流级单调（同流不重号）', () => {
  it('同流两次缺 id 的工具调用 → 兜底 id 唯一且递增（call_0/call_1）', async () => {
    const client = {
      responses: {
        create: fakeSend([
          // 第一段工具调用：delta 缺 item_id + done 项 id/call_id 双缺
          { type: 'response.function_call_arguments.delta', delta: '{"x":1}' },
          { type: 'response.output_item.done', item: { type: 'function_call', name: 'tool_a', arguments: '{"x":1}' } },
          // 第二段工具调用：同款缺 id 形态（修复前 map.size 格局下重号 call_1）
          { type: 'response.function_call_arguments.delta', delta: '{"y":2}' },
          { type: 'response.output_item.done', item: { type: 'function_call', name: 'tool_b', arguments: '{"y":2}' } },
          { type: 'response.completed', response: { usage: { input_tokens: 5, output_tokens: 4 } } },
        ]),
      },
    } as unknown as OpenAI
    const evs = await collect(
      createOpenAIResponsesProvider({ ...CONF, protocol: 'openai-responses' } as ProviderConf, client),
      {
        systemPrompt: '',
        messages: [{ role: 'user', content: 'hi' }],
        tools: [{ name: 'tool_a', description: 'd', input_schema: { type: 'object', properties: {} } }],
      },
    )
    const tools = evs.filter((e) => e.type === 'tool')
    expect(tools).toHaveLength(2)
    expect(tools[0]).toMatchObject({ type: 'tool', id: 'call_0', name: 'tool_a' })
    expect(tools[1]).toMatchObject({ type: 'tool', id: 'call_1', name: 'tool_b' })
    expect(new Set(tools.map((t) => (t as { id: string }).id)).size).toBe(2)
    expect(evs.some((e) => e.type === 'done')).toBe(true)
  })
})