/**
 * Responses 协议适配器单测（R0916-5b 拆分件，2026-09-16）。
 *
 * 拆分来源：test/ai/provider/adapter.test.ts（原「双协议适配器单测」，原头注沿革
 * 见残核 adapter.test.ts）——本件承接「Responses 适配器（R1-R4）」describe 及其
 * 专属装置（RCONF / completedEvent / fakeResponsesClient / emptyResponsesStore，
 * 仅本域使用故随块同迁、不抽公共 fixtures）整块搬移零改动。
 */
import { describe, expect, it } from 'vitest'
import OpenAI from 'openai'
import { createOpenAIResponsesProvider } from '../../../src/ai/provider/responses-adapter.js'
import { generateTool } from '../../../src/ai/gen.js'
import type { GenEvent, GenRequest, ModelProvider, ProviderConf } from '../../../src/ai/provider/index.js'
import type { ProviderStore } from '../../../src/ai/provider/store.js'
import { CONF, REQ, collect } from './adapter-fixtures.js'

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

  // 五轮重评修复批（C103）：伪流 + 工具产出形态——completed.output 只含 function_call
  //（无 output_item.done 流出）→ 回填 tool 事件 + done(tool_use)。原实现回填只处理
  // message 项，此形态无 tool 事件且 hasOutput 判 true 正常 emitDone，工具型调用方拿
  // input:null 报「产出为空或非对象」。
  it('C103 伪流 completed 只含 function_call → 回填 tool 事件 + done(tool_use)', async () => {
    const { client } = fakeResponsesClient(() => [
      {
        type: 'response.completed',
        response: {
          output: [{ type: 'function_call', call_id: 'call_x', name: 'submit_chapter', arguments: '{"标题":"x"}' }],
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      },
    ])
    const evs = await collect(createOpenAIResponsesProvider(RCONF, client), REQ)
    expect(evs.find((e) => e.type === 'tool')).toMatchObject({
      type: 'tool',
      id: 'call_x',
      name: 'submit_chapter',
      input: { 标题: 'x' },
    })
    expect(evs.find((e) => e.type === 'done')).toMatchObject({ type: 'done', stopReason: 'tool_use' })
  })

  // C103 对照组：正常流已 yield 过 tool（output_item.done 臂）→ completed 回填不重复
  it('C103 正常流 tool 已产出 → completed 不重复回填', async () => {
    const { client } = fakeResponsesClient(() => [
      { type: 'response.output_item.done', item: { type: 'function_call', call_id: 'call_y', name: 'toolA', arguments: '{"a":1}' } },
      {
        type: 'response.completed',
        response: {
          output: [{ type: 'function_call', call_id: 'call_y', name: 'toolA', arguments: '{"a":1}' }],
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      },
    ])
    const evs = await collect(createOpenAIResponsesProvider(RCONF, client), REQ)
    expect(evs.filter((e) => e.type === 'tool')).toHaveLength(1)
    expect(evs.find((e) => e.type === 'done')).toMatchObject({ type: 'done', stopReason: 'tool_use' })
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
