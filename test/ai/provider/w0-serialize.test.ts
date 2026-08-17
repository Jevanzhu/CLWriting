/**
 * W0 协议层出站序列化测试。
 *
 * 验证 ChatMsg（纯文本 + ContentBlock 数组）→ 三协议线格式的转换正确性。
 * 假 SDK client 记录 create() 入参，断言线格式——不导出 toParams，不破坏封装。
 *
 * 验收红线：纯文本 messages 与改动前逐字节一致；block 数组在三协议下各自正确。
 */
import { describe, expect, it } from 'vitest'
import Anthropic from '@anthropic-ai/sdk'
import OpenAI from 'openai'
import { createAnthropicProvider } from '../../../src/ai/provider/anthropic-adapter.js'
import { createOpenAIProvider } from '../../../src/ai/provider/openai-adapter.js'
import { createOpenAIResponsesProvider } from '../../../src/ai/provider/index.js'
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

/** 跑完流并返回捕获的线格式 params（Anthropic；model 可覆盖，测表驱动分支用） */
async function runAnthropic(req: GenRequest, model = CONF.model): Promise<Record<string, unknown>> {
  const client = captureAnthropic()
  const prov = createAnthropicProvider({ ...CONF, model } as ProviderConf, client)
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

/** Responses 线 conf：gpt-5 走 gpt 族 quirks（echoReasoning=encrypted / effortWire=reasoning-effort） */
const RCONF = {
  ...CONF,
  protocol: 'openai-responses' as const,
  auth: 'bearer' as const,
  model: 'gpt-5',
} as ProviderConf

/** 捕获型假 Responses client：create() 记录第一参数后吐 response.completed 收尾流 */
function captureResponses(): OpenAI {
  let captured: Record<string, unknown> = {}
  const client = {
    responses: {
      create: async function* (params: Record<string, unknown>): AsyncGenerator<unknown> {
        captured = params
        // R1 终止事件契约：completed 收尾（带 message 产出项，避免被判空产出）
        yield {
          type: 'response.completed',
          response: { output: [{ type: 'message' }], usage: { input_tokens: 1, output_tokens: 1 } },
        }
      },
    },
  } as unknown as OpenAI
  Object.defineProperty(client, '_captured', { get: () => captured })
  return client
}

/** 跑完流并返回捕获的线格式 params（OpenAI Responses） */
async function runResponses(req: GenRequest): Promise<Record<string, unknown>> {
  const client = captureResponses()
  const prov = createOpenAIResponsesProvider(RCONF, client)
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

  // 表驱动重构 §6.1：structured → output_config.format 按表 structuredMode 翻译
  // （deepseek 走 anthropic 端点时硬编码 json_schema 会 400「格式有问题」）
  it('claude 系列 structured → output_config.format.json_schema', async () => {
    const params = await runAnthropic(
      { systemPrompt: '', messages: [{ role: 'user', content: 'hi' }], structured: { schema: { type: 'object', properties: { a: { type: 'string' } } } } },
      'claude-sonnet-5',
    )
    const oc = params['output_config'] as Record<string, unknown>
    expect(oc['format']).toEqual({ type: 'json_schema', schema: { type: 'object', properties: { a: { type: 'string' } } } })
  })

  it('deepseek 系列 structured → output_config.format.json_object（不带 schema）', async () => {
    const params = await runAnthropic(
      { systemPrompt: '', messages: [{ role: 'user', content: 'hi' }], structured: { schema: { type: 'object' } } },
      'deepseek-v4-flash',
    )
    const oc = params['output_config'] as Record<string, unknown>
    expect(oc['format']).toEqual({ type: 'json_object' })
  })

  it('unknown 系列 structured → 不发 format（结构化模式 none 保守省略）', async () => {
    const params = await runAnthropic(
      { systemPrompt: '', messages: [{ role: 'user', content: 'hi' }], structured: { schema: { type: 'object' } } },
      'some-unknown-model',
    )
    expect(params['output_config']).toBeUndefined()
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

// ── disable_parallel_tool_use 表驱动（#12）──────────

describe('W0: disable_parallel_tool_use', () => {
  it('claude 系列（parallelControl=true）→ disable_parallel_tool_use: true', async () => {
    const params = await runAnthropic(
      {
        systemPrompt: '',
        messages: [{ role: 'user', content: 'hi' }],
        tools: [{ name: 't', input_schema: {} }],
        toolChoice: 'auto',
      },
      'claude-sonnet-5',
    )
    expect(params['tool_choice']).toEqual({ type: 'auto', disable_parallel_tool_use: true })
  })

  it('unknown 系列（parallelControl=false）→ 不发 disable_parallel_tool_use', async () => {
    const params = await runAnthropic({
      systemPrompt: '',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [{ name: 't', input_schema: {} }],
      toolChoice: 'auto',
    })
    expect(params['tool_choice']).toEqual({ type: 'auto' })
  })
})

// ── 纯文本 / 基础参数 → Responses 线格式 ──────────

describe('W0: Responses 线基础参数（gpt-5）', () => {
  it('纯文本 → developer + user 直传；maxTokens→max_output_tokens；store:false 恒存在', async () => {
    const params = await runResponses({
      systemPrompt: 'sys',
      messages: [{ role: 'user', content: 'hello' }],
      maxTokens: 1024,
    })
    // systemPrompt → developer 角色（OpenAI 新约定）；user 纯文本直传
    const input = params['input'] as { role: string; content: string }[]
    expect(input).toEqual([
      { role: 'developer', content: 'sys' },
      { role: 'user', content: 'hello' },
    ])
    expect(params['model']).toBe('gpt-5')
    expect(params['stream']).toBe(true)
    expect(params['max_output_tokens']).toBe(1024)
    // 缺口 9：store:false 恒存在（书稿全文上行场景响应不得留存）
    expect(params['store']).toBe(false)
  })

  it('无 tools/toolChoice → 不发 include / parallel_tool_calls / tools 键', async () => {
    const params = await runResponses({
      systemPrompt: '',
      messages: [{ role: 'user', content: 'hi' }],
    })
    expect(params['include']).toBeUndefined()
    expect(params['parallel_tool_calls']).toBeUndefined()
    expect(params['tools']).toBeUndefined()
  })
})

// ── 工具往返重排 → Responses 线格式（缺口 11）──────────

describe('W0: 工具往返 → Responses 线格式', () => {
  it('assistant reasoning+text+tool_use → reasoning item 先于 text/function_call；tool_result → function_call_output', async () => {
    const messages: ChatMsg[] = [
      { role: 'user', content: '帮我查第5章' },
      {
        role: 'assistant',
        content: [
          // block 顺序故意 text 在前——线格式重排为 reasoning 先行（Responses 语义）
          { type: 'text', text: '好的' },
          { type: 'reasoning', text: '思考中', encrypted: 'enc-1', itemId: 'rs_1' },
          { type: 'tool_use', id: 'call_1', name: 'check_chapter', input: { chapter: 5 } },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', toolUseId: 'call_1', content: '机检全绿' },
        ],
      },
    ]
    const params = await runResponses({ systemPrompt: '', messages })
    const input = params['input'] as Record<string, unknown>[]

    // user 纯文本直传
    expect(input[0]).toEqual({ role: 'user', content: '帮我查第5章' })

    // assistant 轮展开顺序：reasoning item → text → function_call
    expect(input[1]).toEqual({ type: 'reasoning', id: 'rs_1', encrypted_content: 'enc-1', summary: [] })
    expect(input[2]).toEqual({ role: 'assistant', content: '好的' })
    expect(input[3]).toEqual({
      type: 'function_call',
      call_id: 'call_1',
      name: 'check_chapter',
      arguments: '{"chapter":5}',
    })
    // arguments 必须是 JSON 字符串，不是对象
    expect(typeof input[3]!['arguments']).toBe('string')

    // user 轮 tool_result → function_call_output（call_id 关联）
    expect(input[4]).toEqual({ type: 'function_call_output', call_id: 'call_1', output: '机检全绿' })
  })
})

// ── reasoning 回插双条件（缺口 11）──────────

describe('W0: reasoning 回插双条件', () => {
  it('缺 itemId → 不回插 reasoning item（id 缺失回传会被拒）', async () => {
    const messages: ChatMsg[] = [
      {
        role: 'assistant',
        content: [
          { type: 'reasoning', text: '无 id', encrypted: 'enc-1' },
          { type: 'text', text: 'ok' },
        ],
      },
    ]
    const params = await runResponses({ systemPrompt: '', messages })
    const input = params['input'] as Record<string, unknown>[]
    expect(input.some((it) => it['type'] === 'reasoning')).toBe(false)
    expect(input).toEqual([{ role: 'assistant', content: 'ok' }])
  })

  it('缺 encrypted → 不回插 reasoning item', async () => {
    const messages: ChatMsg[] = [
      {
        role: 'assistant',
        content: [
          { type: 'reasoning', text: '无密文', itemId: 'rs_1' },
          { type: 'text', text: 'ok' },
        ],
      },
    ]
    const params = await runResponses({ systemPrompt: '', messages })
    const input = params['input'] as Record<string, unknown>[]
    expect(input.some((it) => it['type'] === 'reasoning')).toBe(false)
    expect(input).toEqual([{ role: 'assistant', content: 'ok' }])
  })
})

// ── Responses 线杂项参数 ──────────

describe('W0: Responses 线 stop / tools / effort / tool_choice', () => {
  // 缺口 10：stop_sequences 无对应参数，静默忽略
  it('stopSequences → 无任何 stop 相关键', async () => {
    const params = await runResponses({
      systemPrompt: '',
      messages: [{ role: 'user', content: 'hi' }],
      stopSequences: ['END', '\n\n'],
    })
    expect(params['stop']).toBeUndefined()
    expect(Object.keys(params).some((k) => k.toLowerCase().includes('stop'))).toBe(false)
  })

  it('tools + effort（gpt 族）→ include 深等 + reasoning.effort 落位', async () => {
    const params = await runResponses({
      systemPrompt: '',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [{ name: 'check_chapter', description: '机检章节', input_schema: { type: 'object', properties: { chapter: { type: 'number' } } } }],
      effort: 'high',
    })
    // 缺口 11 前半：store:false + 工具调用 → include 让响应携带加密推理项
    expect(params['include']).toEqual(['reasoning.encrypted_content'])
    // gpt 族 effortWire='reasoning-effort' → params.reasoning.effort（档位透传）
    expect(params['reasoning']).toEqual({ effort: 'high' })
    // tools 形状：扁平 {type,name,description,parameters}
    const tools = params['tools'] as Record<string, unknown>[]
    expect(tools).toEqual([
      {
        type: 'function',
        name: 'check_chapter',
        description: '机检章节',
        parameters: { type: 'object', properties: { chapter: { type: 'number' } } },
      },
    ])
  })

  it('toolChoice=any/auto → tool_choice 字符串形态；parallel_tool_calls:false（一轮最多一个调用）', async () => {
    const paramsAny = await runResponses({
      systemPrompt: '',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [{ name: 't', input_schema: {} }],
      toolChoice: 'any',
    })
    // named 档：any → required
    expect(paramsAny['tool_choice']).toBe('required')
    expect(paramsAny['parallel_tool_calls']).toBe(false)

    const paramsAuto = await runResponses({
      systemPrompt: '',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [{ name: 't', input_schema: {} }],
      toolChoice: 'auto',
    })
    expect(paramsAuto['tool_choice']).toBe('auto')
  })

  it('toolChoice=tool+toolName → 扁平指名 {type:"function",name}（非 Chat 线嵌套形态）', async () => {
    const params = await runResponses({
      systemPrompt: '',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [{ name: 'check_chapter', input_schema: {} }],
      toolChoice: 'tool',
      toolName: 'check_chapter',
    })
    expect(params['tool_choice']).toEqual({ type: 'function', name: 'check_chapter' })
  })
})
