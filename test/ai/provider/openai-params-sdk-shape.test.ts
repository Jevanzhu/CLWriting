/**
 * R0916-7-P3-16（2026-09-24 全项目源码质量与优雅度评审 P3-16 第一项）回归：OpenAI 系请求参数
 * 按 SDK 类型构造。
 *
 * 修复前：openai-adapter / responses-adapter 的 toParams 先造 `Record<string, unknown>`、
 * 调用点再 `as unknown as` 转 SDK 参数类型——SDK 的形状校验整段失效（字段名打错、必填
 * 缺失、取值越界都不会被编译器拦下）。
 *
 * 本件两面锁：
 * ① 类型层断言——参数构造返回值可不经断言直接赋给 SDK 参数类型（编译期；`as unknown as`
 *    若回流即 tsc 报错）；
 * ② 关键字段形状用例——按 SDK 类型构造后，线上请求体的键集合与取值逐项不变（厂商扩展
 *    字段经交叉类型/白名单转换点表达，SDK 必填而被本线有意省略的字段不回流）。
 */
import { describe, expect, it } from 'vitest'
import OpenAI from 'openai'
import { createOpenAIProviderChat, toParams as toChatParams } from '../../../src/ai/provider/openai-adapter.js'
import {
  createOpenAIResponsesProvider,
  asSdkParams,
  toParams as toResponsesParams,
} from '../../../src/ai/provider/responses-adapter.js'
import { CONF, REQ, collect } from './adapter-fixtures.js'
import type { GenRequest, ProviderConf } from '../../../src/ai/provider/index.js'

// ── ① 类型层断言（无断言可赋性） ─────────────────────────────────────

describe('R0916-7-P3-16：参数构造返回值的类型层可赋性', () => {
  it('openai Chat：toParams 返回值直接就是 SDK 参数类型（无需 as unknown as）', () => {
    const probe: (conf: ProviderConf, req: GenRequest) => OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming =
      toChatParams
    expect(typeof probe).toBe('function')
  })

  it('responses：toParams + 白名单转换点即 SDK 参数类型（差异仅 tools[].strict）', () => {
    const conv: (p: ReturnType<typeof toResponsesParams>) => OpenAI.Responses.ResponseCreateParamsStreaming =
      asSdkParams
    const probe: (conf: ProviderConf, req: GenRequest) => OpenAI.Responses.ResponseCreateParamsStreaming = (
      conf,
      req,
    ) => conv(toResponsesParams(conf, req))
    expect(typeof probe).toBe('function')
  })
})

// ── ② 关键字段形状（运行时捕获实发参数） ──────────────────────────────

/** 假 Chat 客户端：捕获 create 入参（params[0] = 首发 attempt 参数面） */
function fakeChatClient(): { client: OpenAI; params: Record<string, unknown>[] } {
  const params: Record<string, unknown>[] = []
  const client = {
    chat: {
      completions: {
        create: async (p: unknown): Promise<AsyncGenerator<unknown>> => {
          params.push(p as Record<string, unknown>)
          return (async function* () {
            yield {
              choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }],
              usage: { prompt_tokens: 1, completion_tokens: 1 },
            }
          })()
        },
      },
    },
  } as unknown as OpenAI
  return { client, params }
}

/** 假 Responses 客户端：同上 */
function fakeResponsesClient(): { client: OpenAI; params: Record<string, unknown>[] } {
  const params: Record<string, unknown>[] = []
  const client = {
    responses: {
      create: async (p: unknown): Promise<AsyncGenerator<unknown>> => {
        params.push(p as Record<string, unknown>)
        return (async function* () {
          yield {
            type: 'response.completed',
            response: { output: [{ type: 'message' }], usage: { input_tokens: 1, output_tokens: 1 } },
          }
        })()
      },
    },
  } as unknown as OpenAI
  return { client, params }
}

const TOOL = { name: 'read_chapter', input_schema: { type: 'object', properties: {} } }
const TOOL_WITH_DESC = { name: 'read_chapter', description: '读章', input_schema: { type: 'object', properties: {} } }

describe('R0916-7-P3-16：Chat 线参数按 SDK 类型构造后的键形状', () => {
  it('gpt 家族：max_completion_tokens 键 + reasoning_effort 直赋（EffortLevel ⊂ SDK ReasoningEffort）', () => {
    const built = toChatParams({ ...CONF, model: 'gpt-5' }, { ...REQ, effort: 'high', maxTokens: 123 })
    expect(built['max_completion_tokens']).toBe(123)
    expect('max_tokens' in built).toBe(false)
    expect(built['reasoning_effort']).toBe('high')
    expect('thinking' in built).toBe(false) // gpt 家族 thinkingWithEffort=false
  })

  it('deepseek 家族：max_tokens 键 + thinking 扩展字段（交叉类型表达的厂商双写法）', () => {
    const built = toChatParams({ ...CONF, model: 'deepseek-chat' }, { ...REQ, effort: 'medium', maxTokens: 9 })
    expect(built['max_tokens']).toBe(9)
    expect(built['reasoning_effort']).toBe('high') // trimEffort: medium → high
    expect(built['thinking']).toEqual({ type: 'enabled' })
  })

  it('工具项：description 缺省时键缺席（条件 omit），parameters 原样透传', () => {
    const built = toChatParams({ ...CONF, model: 'gpt-5' }, { ...REQ, tools: [TOOL, TOOL_WITH_DESC] })
    const tools = (built['tools'] ?? []) as OpenAI.Chat.Completions.ChatCompletionFunctionTool[]
    expect(tools).toHaveLength(2)
    expect('description' in tools[0]!.function).toBe(false)
    expect(tools[1]!.function['description']).toBe('读章')
    expect(tools[0]!.function['parameters']).toEqual({ type: 'object', properties: {} })
  })

  it('结构化 + 流式 usage + stop：response_format / stream_options / stop 三键形状不变', () => {
    const built = toChatParams(
      { ...CONF, model: 'gpt-5' },
      { ...REQ, structured: { schema: { type: 'object' } }, stopSequences: ['\n\n'], maxTokens: 1 },
    )
    expect(built['response_format']).toEqual({
      type: 'json_schema',
      json_schema: { name: 'output', schema: { type: 'object' }, strict: true },
    })
    expect(built['stream_options']).toEqual({ include_usage: true })
    expect(built['stop']).toEqual(['\n\n'])
  })

  it('model 缺省 → 空串兜底（SDK 参数校验不再被绕开的既有行为）', () => {
    const built = toChatParams({ ...CONF, model: undefined }, REQ)
    expect(built.model).toBe('')
  })

  it('实发路径：adapter 传给 SDK 的就是 toParams 的产物（无中间改写，风格与 Responses 线一致）', async () => {
    const { client, params } = fakeChatClient()
    await collect(createOpenAIProviderChat({ ...CONF, model: 'gpt-5' }, client), REQ)
    expect(JSON.parse(JSON.stringify(params[0]))).toEqual(
      JSON.parse(JSON.stringify(toChatParams({ ...CONF, model: 'gpt-5' }, REQ))),
    )
  })
})

describe('R0916-7-P3-16：Responses 线参数按 SDK 类型构造后的键形状', () => {
  const RCONF: ProviderConf = { ...CONF, protocol: 'openai-responses', model: 'gpt-5' }

  it('gpt-5：input 首项 developer 角色 + store:false + reasoning.effort + include', () => {
    const built = toResponsesParams(RCONF, { ...REQ, systemPrompt: '系统', effort: 'high', tools: [TOOL_WITH_DESC] })
    expect(built.input).toEqual([
      { role: 'developer', content: '系统' },
      { role: 'user', content: 'hi' },
    ])
    expect(built.store).toBe(false)
    expect(built['reasoning']).toEqual({ effort: 'high' })
    expect(built['include']).toEqual(['reasoning.encrypted_content'])
  })

  it('工具项：本线有意不发 strict（白名单转换点已登记的差异），parameters 原样透传', () => {
    const built = toResponsesParams(RCONF, { ...REQ, tools: [TOOL] })
    const tools = built['tools'] as Array<Record<string, unknown>>
    expect(tools).toHaveLength(1)
    expect('strict' in tools[0]!).toBe(false)
    expect(tools[0]).toMatchObject({
      type: 'function',
      name: 'read_chapter',
      parameters: { type: 'object', properties: {} },
    })
  })

  it('deepseek 家族：effort 落 output_config（非 SDK 扩展字段）；structuredMode=json_object 故不发 text.format', () => {
    const built = toResponsesParams(
      { ...RCONF, model: 'deepseek-chat' },
      { ...REQ, effort: 'medium', structured: { schema: { type: 'object' } } },
    )
    expect(built['output_config']).toEqual({ effort: 'high' }) // trimEffort: medium → high
    expect('reasoning_effort' in built).toBe(false)
    expect('reasoning' in built).toBe(false)
    expect('text' in built).toBe(false) // 该族 json_object：text.format 不发（prompt 约束兜底）
  })

  it('structured（gpt 族 json_schema）→ text.format 形状不变', () => {
    const built = toResponsesParams(RCONF, { ...REQ, structured: { schema: { type: 'object' } } })
    expect(built['text']).toEqual({
      format: { type: 'json_schema', name: 'output', schema: { type: 'object' }, strict: true },
    })
  })

  it('grok 家族：effort 落顶层 reasoning_effort（非 SDK 扩展字段）', () => {
    const built = toResponsesParams({ ...RCONF, model: 'grok-4' }, { ...REQ, effort: 'low' })
    expect(built['reasoning_effort']).toBe('low')
    expect('reasoning' in built).toBe(false)
  })

  it('tool_choice 指名为扁平 {type:function,name}（非 Chat 的嵌套形状）', () => {
    const built = toResponsesParams(RCONF, {
      ...REQ,
      toolChoice: 'tool',
      toolName: 'read_chapter',
      tools: [TOOL_WITH_DESC],
    })
    expect(built['tool_choice']).toEqual({ type: 'function', name: 'read_chapter' })
  })

  it('实发路径：adapter 传给 SDK 的就是白名单转换后的参数对象（键集合与取值同 toParams）', async () => {
    const { client, params } = fakeResponsesClient()
    const provider = createOpenAIResponsesProvider(RCONF, client)
    await collect(provider, REQ)
    expect(Object.keys(params[0]!).sort()).toEqual(Object.keys(toResponsesParams(RCONF, REQ)).sort())
    expect(JSON.parse(JSON.stringify(params[0]))).toEqual(JSON.parse(JSON.stringify(toResponsesParams(RCONF, REQ))))
  })
})
