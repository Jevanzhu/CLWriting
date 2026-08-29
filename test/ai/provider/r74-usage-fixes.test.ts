/**
 * R74（二十二轮批 A）回归：AI 记账正确性两件。
 *
 * R74-1：Responses 线 completed/incomplete 事件无 usage → 估计入账（对齐 openai/
 * anthropic 线 R73-1 形态）。修复前 toUsage(null) 恒 {0,0} 且无 estimated 标记——
 * 预算闸 tokens/cost 对不回 usage 的 Responses 端点永不生效。
 *
 * R74-7：Anthropic 线兜底路径保留 message_start 已实测的 cache 读/写两档。修复前
 * R73-1 整包重估输入把它们丢弃——usage 四档分计在兜底路径少两档，cache 计费面被清零。
 */
import { describe, expect, it } from 'vitest'
import Anthropic from '@anthropic-ai/sdk'
import OpenAI from 'openai'
import { createAnthropicProvider } from '../../../src/ai/provider/anthropic-adapter.js'
import { createOpenAIResponsesProvider } from '../../../src/ai/provider/responses-adapter.js'
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

/** 伪网关流：客户端返回 async generator（r73-gateway-usage.test.ts fakeSend 同款手法） */
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

describe('R74-1: Responses 线终止事件无 usage → 估计入账', () => {
  const RCONF = { ...CONF, protocol: 'openai-responses' as const } as ProviderConf

  it('completed 无 usage → done 入账非 0 且带 estimated（修复前恒 0/0）', async () => {
    const client = {
      responses: {
        create: fakeSend([
          { type: 'response.output_text.delta', delta: '第一段正文内容。' },
          { type: 'response.output_text.delta', delta: '第二段正文内容。' },
          { type: 'response.completed', response: { output: [{ type: 'message' }], usage: null } },
        ]),
      },
    } as unknown as OpenAI
    const evs = await collect(createOpenAIResponsesProvider(RCONF, client), {
      systemPrompt: '系统提示词',
      messages: [{ role: 'user', content: '写一段' }],
    })
    const done = evs.find((e) => e.type === 'done')
    expect(done).toBeDefined()
    if (done?.type !== 'done') return
    // 修复前：toUsage(null) = {inputTokens: 0, outputTokens: 0} 且无 estimated——预算闸永不生效
    expect(done.usage.estimated).toBe(true)
    // 折算口径锚定（0.6 token/码位向上取整，与 r73 openai 线同款）：input = '系统提示词'
    // +'写一段' 8 码位 → 5；output = 两段 delta 共 16 码位 → 10
    expect(done.usage.inputTokens).toBe(5)
    expect(done.usage.outputTokens).toBe(10)
    expect(done.stopReason).toBe('stop')
  })

  it('completed 带 usage → 实测入账不标 estimated（估计口径不扩大）', async () => {
    const client = {
      responses: {
        create: fakeSend([
          { type: 'response.completed', response: { output: [{ type: 'message' }], usage: { input_tokens: 3, output_tokens: 2 } } },
        ]),
      },
    } as unknown as OpenAI
    const evs = await collect(createOpenAIResponsesProvider(RCONF, client), { systemPrompt: '', messages: [{ role: 'user', content: 'hi' }] })
    const done = evs.find((e) => e.type === 'done')
    expect(done).toMatchObject({ usage: { inputTokens: 3, outputTokens: 2 } })
    if (done?.type !== 'done') return
    expect(done.usage.estimated).toBeUndefined()
  })

  it('incomplete(max_output_tokens) 无 usage → 估计入账，在途 tool 参数并入产出折算', async () => {
    const client = {
      responses: {
        create: fakeSend([
          // 截断发生在 function_call 参数增量中途：无 output_item.done，残留 toolAccum
          { type: 'response.function_call_arguments.delta', item_id: 'fc_1', delta: '{"正文":"写到一半被截断' },
          { type: 'response.incomplete', response: { incomplete_details: { reason: 'max_output_tokens' }, usage: null } },
        ]),
      },
    } as unknown as OpenAI
    const evs = await collect(createOpenAIResponsesProvider(RCONF, client), { systemPrompt: '', messages: [{ role: 'user', content: 'hi' }] })
    const done = evs.find((e) => e.type === 'done')
    expect(done).toBeDefined()
    if (done?.type !== 'done') return
    expect(done.stopReason).toBe('max_tokens')
    expect(done.usage.estimated).toBe(true)
    // input = 'hi' 2 码位 → 2；output = 残留 tool 参数串 14 码位 → ceil(8.4) = 9
    //（修复前恒 0/0——截断场景网关更常缺 usage）
    expect(done.usage.inputTokens).toBe(2)
    expect(done.usage.outputTokens).toBe(9)
  })
})

describe('R74-7: Anthropic 兜底路径保留 message_start 实测 cache 两档', () => {
  const ACONF = { ...CONF, protocol: 'anthropic' as const, auth: 'anthropic' as const } as ProviderConf

  it('message_start 带 cache 读/写 + message_delta 无 usage → 四档齐备（估计只补主输入/输出）', async () => {
    const client = {
      messages: {
        create: fakeSend([
          { type: 'message_start', message: { usage: { input_tokens: 42, cache_read_input_tokens: 100, cache_creation_input_tokens: 50 } } },
          { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '正文产出' } },
          { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
        ]),
      },
    } as unknown as Anthropic
    const evs = await collect(createAnthropicProvider(ACONF, client), { systemPrompt: '', messages: [{ role: 'user', content: 'hi' }] })
    const done = evs.find((e) => e.type === 'done')
    expect(done).toBeDefined()
    if (done?.type !== 'done') return
    expect(done.usage.inputTokens).toBe(42) // 实测主输入保留（R73-1 既有口径）
    // 修复前：R73-1 整包重估输入时这两档被丢弃（undefined）——cache 计费面清零
    expect(done.usage.cacheReadTokens).toBe(100)
    expect(done.usage.cacheWriteTokens).toBe(50)
    expect(done.usage.outputTokens).toBe(3) // 估计补齐：'正文产出' 4 码位 → ceil(2.4) = 3
    expect(done.usage.estimated).toBe(true)
  })

  it('对照：message_start 无 cache 字段 → 兜底 usage 不带 cache 档（口径不扩大）', async () => {
    const client = {
      messages: {
        create: fakeSend([
          { type: 'message_start', message: { usage: { input_tokens: 7 } } },
          { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '正文产出' } },
          { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
        ]),
      },
    } as unknown as Anthropic
    const evs = await collect(createAnthropicProvider(ACONF, client), { systemPrompt: '', messages: [{ role: 'user', content: 'hi' }] })
    const done = evs.find((e) => e.type === 'done')
    expect(done).toBeDefined()
    if (done?.type !== 'done') return
    expect(done.usage.inputTokens).toBe(7)
    expect(done.usage.cacheReadTokens).toBeUndefined()
    expect(done.usage.cacheWriteTokens).toBeUndefined()
    expect(done.usage.estimated).toBe(true)
  })
})
