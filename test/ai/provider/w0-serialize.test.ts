/**
 * W0 协议层出站序列化测试。
 *
 * 验证 ChatMsg（纯文本 + ContentBlock 数组）→ 两协议线格式的转换正确性。
 * 假 SDK client 记录 create() 入参，断言线格式——不导出 toParams，不破坏封装。
 *
 * 验收红线：纯文本 messages 与改动前逐字节一致；block 数组在两协议下各自正确。
 */
import { describe, expect, it } from 'vitest'
import Anthropic from '@anthropic-ai/sdk'
import OpenAI from 'openai'
import { createAnthropicProvider } from '../../../src/ai/provider/anthropic-adapter.js'
import { createOpenAIProvider } from '../../../src/ai/provider/openai-adapter.js'
import type { GenRequest, ProviderConf, ChatMsg } from '../../../src/ai/provider/index.js'

const CONF = {
  name: 't',
  protocol: 'anthropic' as const,
  auth: 'anthropic' as const,
  baseUrl: 'https://example.local',
  model: 'test-model',
  apiKey: 'sk-secret',
  caps: null,
} as ProviderConf

/** 捕获型假 Anthropic client：create() 记录第一参数后吐空流 */
function captureAnthropic(): Anthropic {
  let captured: Record<string, unknown> = {}
  const client = {
    messages: {
      create: async function* (params: Record<string, unknown>): AsyncGenerator<unknown> {
        captured = params
        yield { type: 'message_delta', usage: { input_tokens: 1, output_tokens: 1 }, delta: { stop_reason: 'end_turn' } }
      },
    },
  } as unknown as Anthropic
  // 在 client 上挂捕获 getter
  Object.defineProperty(client, '_captured', { get: () => captured })
  return client
}

/** 捕获型假 OpenAI client：create() 记录第一参数后吐空流 */
function captureOpenAI(): OpenAI {
  let captured: Record<string, unknown> = {}
  const client = {
    chat: {
      completions: {
        create: async function* (params: Record<string, unknown>): AsyncGenerator<unknown> {
          captured = params
          yield { choices: [{ delta: {}, finish_reason: 'stop' }] }
          yield { choices: [], usage: { prompt_tokens: 1, completion_tokens: 1 } }
        },
      },
    },
  } as unknown as OpenAI
  Object.defineProperty(client, '_captured', { get: () => captured })
  return client
}

/** 跑完流并返回捕获的线格式 params（Anthropic） */
async function runAnthropic(req: GenRequest): Promise<Record<string, unknown>> {
  const client = captureAnthropic()
  const prov = createAnthropicProvider(CONF, client)
  for await (const _ev of prov.stream(req, new AbortController().signal)) { void _ev }
  return (client as unknown as { _captured: Record<string, unknown> })._captured
}

/** 跑完流并返回捕获的线格式 params（OpenAI） */
async function runOpenAI(req: GenRequest): Promise<Record<string, unknown>> {
  const client = captureOpenAI()
  const prov = createOpenAIProvider(CONF, client)
  for await (const _ev of prov.stream(req, new AbortController().signal)) { void _ev }
  return (client as unknown as { _captured: Record<string, unknown> })._captured
}

// ── 纯文本向后兼容 ──────────────────────────────

describe('W0: 纯文本 messages 向后兼容', () => {
  it('Anthropic 纯文本 → role + content 直传', async () => {
    const params = await runAnthropic({
      systemPrompt: 'sys',
      messages: [{ role: 'user', content: 'hello' }],
    })
    const messages = params['messages'] as { role: string; content: string }[]
    expect(messages).toEqual([{ role: 'user', content: 'hello' }])
  })

  it('OpenAI 纯文本 → system + user 直传', async () => {
    const params = await runOpenAI({
      systemPrompt: 'sys',
      messages: [{ role: 'user', content: 'hello' }],
    })
    const messages = params['messages'] as { role: string; content: string }[]
    // OpenAI 把 systemPrompt 作为 role:'system' 前置消息
    expect(messages).toEqual([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hello' },
    ])
  })
})

// ── ContentBlock 数组 → Anthropic 线格式 ──────────

describe('W0: block 数组 → Anthropic 线格式', () => {
  it('assistant(tool_use) + user(tool_result) 配对正确', async () => {
    const messages: ChatMsg[] = [
      { role: 'user', content: '帮我查第5章' },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: '好的' },
          { type: 'tool_use', id: 'toolu_1', name: 'check_chapter', input: { chapter: 5 } },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', toolUseId: 'toolu_1', content: '机检全绿' },
        ],
      },
    ]
    const params = await runAnthropic({ systemPrompt: '', messages })
    const out = params['messages'] as { role: string; content: unknown[] }[]

    // assistant 消息：text block + tool_use block
    expect(out[1]!.role).toBe('assistant')
    expect(out[1]!.content).toEqual([
      { type: 'text', text: '好的' },
      { type: 'tool_use', id: 'toolu_1', name: 'check_chapter', input: { chapter: 5 } },
    ])

    // user 消息：tool_result block（toolUseId → tool_use_id）
    expect(out[2]!.role).toBe('user')
    expect(out[2]!.content).toEqual([
      { type: 'tool_result', tool_use_id: 'toolu_1', content: '机检全绿' },
    ])
  })

  it('tool_result isError → is_error: true', async () => {
    const messages: ChatMsg[] = [
      {
        role: 'user',
        content: [{ type: 'tool_result', toolUseId: 't1', content: '失败', isError: true }],
      },
    ]
    const params = await runAnthropic({ systemPrompt: '', messages })
    const out = params['messages'] as { role: string; content: Record<string, unknown>[] }[]
    expect(out[0]!.content[0]).toMatchObject({ type: 'tool_result', is_error: true })
  })
})

// ── ContentBlock 数组 → OpenAI 线格式 ──────────

describe('W0: block 数组 → OpenAI 线格式', () => {
  it('assistant tool_use → tool_calls（arguments 是 JSON 字符串）', async () => {
    const messages: ChatMsg[] = [
      { role: 'user', content: '帮我查第5章' },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: '好的' },
          { type: 'tool_use', id: 'call_1', name: 'check_chapter', input: { chapter: 5 } },
        ],
      },
    ]
    const params = await runOpenAI({ systemPrompt: '', messages })
    const out = params['messages'] as Record<string, unknown>[]

    // user 消息：纯文本
    expect(out[0]).toEqual({ role: 'user', content: '帮我查第5章' })

    // assistant 消息：content='好的' + tool_calls
    const asst = out[1]!
    expect(asst['role']).toBe('assistant')
    expect(asst['content']).toBe('好的')
    const toolCalls = asst['tool_calls'] as Record<string, unknown>[]
    expect(toolCalls).toHaveLength(1)
    expect(toolCalls[0]).toMatchObject({
      id: 'call_1',
      type: 'function',
      function: { name: 'check_chapter', arguments: '{"chapter":5}' },
    })
    // arguments 必须是 JSON 字符串，不是对象
    expect(typeof (toolCalls[0]!['function'] as Record<string, unknown>)['arguments']).toBe('string')
  })

  it('user(tool_result) → 独立 role:tool 消息（每个 tool_result 一条）', async () => {
    const messages: ChatMsg[] = [
      {
        role: 'user',
        content: [
          { type: 'tool_result', toolUseId: 'call_1', content: '结果A' },
          { type: 'tool_result', toolUseId: 'call_2', content: '结果B' },
        ],
      },
    ]
    const params = await runOpenAI({ systemPrompt: '', messages })
    const out = params['messages'] as Record<string, unknown>[]

    // 两个 tool_result → 两条独立 role:'tool' 消息
    const toolMsgs = out.filter((m) => m['role'] === 'tool')
    expect(toolMsgs).toHaveLength(2)
    expect(toolMsgs[0]).toMatchObject({ role: 'tool', tool_call_id: 'call_1', content: '结果A' })
    expect(toolMsgs[1]).toMatchObject({ role: 'tool', tool_call_id: 'call_2', content: '结果B' })
  })

  it('assistant 无 text 只有 tool_use → content=null（OpenAI 要求 assistant 消息有 content 字段）', async () => {
    const messages: ChatMsg[] = [
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'c1', name: 't', input: {} }],
      },
    ]
    const params = await runOpenAI({ systemPrompt: '', messages })
    const out = params['messages'] as Record<string, unknown>[]
    expect(out[0]!['content']).toBeNull()
    expect(Array.isArray(out[0]!['tool_calls'])).toBe(true)
  })
})

// ── disable_parallel_tool_use 补 auto 分支 ──────────

describe('W0: disable_parallel_tool_use', () => {
  it('Anthropic toolChoice=auto → disable_parallel_tool_use: true', async () => {
    const params = await runAnthropic({
      systemPrompt: '',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [{ name: 't', input_schema: {} }],
      toolChoice: 'auto',
    })
    expect(params['tool_choice']).toEqual({ type: 'auto', disable_parallel_tool_use: true })
  })
})
