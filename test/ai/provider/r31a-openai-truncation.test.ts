/**
 * R31-1 / R31-6（三十一轮）回归——OpenAI Chat 线流终止契约与消息展开序：
 *
 * - R31-1：「有 usage 无 finish_reason」的截断流不得按正常完成（done）出场——
 *   须发传输截断 error（retryable），已见 usage 随错上抛（B-12 通道，终态失败按
 *   真实消耗入账，截断不丢计费）。对照：usage 先行的网关形态（Kimi 文档 §4.4，
 *   usage 可在 choices[0] 随任意 chunk 出现）此前会在 finish_reason 之前断流时
 *   把半截文本按 stopReason:'stop' 正常完成落盘。
 * - R31-6：混合 user 消息（text + tool_result）展开序——role:'tool' 先于 user
 *   文本（OpenAI 要求 tool 消息紧跟 assistant tool_calls）。
 */
import { describe, expect, it } from 'vitest'
import OpenAI from 'openai'
import { createOpenAIProvider } from '../../../src/ai/provider/openai-adapter.js'
import type { GenEvent, GenRequest, ProviderConf } from '../../../src/ai/provider/index.js'

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

async function collect(prov: ReturnType<typeof createOpenAIProvider>, req: GenRequest): Promise<GenEvent[]> {
  const out: GenEvent[] = []
  for await (const ev of prov.stream(req, new AbortController().signal)) out.push(ev)
  return out
}

function fakeSend(events: unknown[]): () => AsyncGenerator<unknown> {
  return async function* () {
    for (const e of events) yield e
  }
}

describe('R31-1：有 usage 无 finish_reason = 传输截断', () => {
  it('usage 随内容 chunk 先行、无 finish_reason、流正常结束 → error（非 done）且 usage 上抛', async () => {
    const client = {
      chat: {
        completions: {
          create: fakeSend([
            // usage 先行：内容 chunk 后跟 usage-only chunk（include_usage/网关混合形态），
            // finish_reason 永不到达即断流
            { choices: [{ delta: { content: '半' }, finish_reason: null }] },
            { choices: [], usage: { prompt_tokens: 10, completion_tokens: 1 } },
            { choices: [{ delta: { content: '截' }, finish_reason: null }] },
            // 流在此正常结束——无任何 finish_reason
          ]),
        },
      },
    } as unknown as OpenAI
    const evs = await collect(createOpenAIProvider(CONF, client), REQ)
    expect(evs.some((e) => e.type === 'done')).toBe(false)
    const err = evs.find((e) => e.type === 'error')
    expect(err).toMatchObject({
      type: 'error',
      retryable: true,
      code: 'NETWORK',
      usage: { inputTokens: 10, outputTokens: 1 },
    })
    // 已产出的增量文本仍在（消费者据实处理半截稿）
    expect(evs.filter((e) => e.type === 'text')).toEqual([
      { type: 'text', delta: '半' },
      { type: 'text', delta: '截' },
    ])
  })

  it('对照：finish_reason 到达后 usage-only chunk 收尾 → done 照常（末见 wins 不回归）', async () => {
    const client = {
      chat: {
        completions: {
          create: fakeSend([
            { choices: [{ delta: { content: '完' }, finish_reason: 'stop' }] },
            { choices: [], usage: { prompt_tokens: 7, completion_tokens: 3 } },
          ]),
        },
      },
    } as unknown as OpenAI
    const evs = await collect(createOpenAIProvider(CONF, client), REQ)
    const done = evs.find((e) => e.type === 'done')
    expect(done).toMatchObject({ type: 'done', usage: { inputTokens: 7, outputTokens: 3 }, stopReason: 'stop' })
  })
})

describe('R31-6：混合 user 消息展开序（tool 消息先于 user 文本）', () => {
  it('user 含 tool_result + text → 先 role:tool 后 role:user', async () => {
    let captured: { messages?: Array<Record<string, unknown>> } | undefined = undefined
    const client = {
      chat: {
        completions: {
          create: (params: unknown) => {
            captured = params as { messages: Array<Record<string, unknown>> }
            return fakeSend([{ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] }])()
          },
        },
      },
    } as unknown as OpenAI
    const req: GenRequest = {
      systemPrompt: '',
      messages: [
        { role: 'assistant', content: [{ type: 'tool_use', id: 'call_1', name: 'read_doc', input: { path: 'a.md' } }] },
        {
          role: 'user',
          content: [
            { type: 'tool_result', toolUseId: 'call_1', content: '文档内容' },
            { type: 'text', text: '请继续' },
          ],
        },
      ],
    }
    await collect(createOpenAIProvider(CONF, client), req)
    const msgs: Array<Record<string, unknown>> = (captured as { messages?: Array<Record<string, unknown>> } | undefined)?.messages ?? []
    const roles = msgs.map((m) => m.role)
    // tool 消息必须紧跟 assistant tool_calls：user 文本不得插在中间
    expect(roles).toEqual(['assistant', 'tool', 'user'])
    expect(msgs[1]).toMatchObject({ role: 'tool', tool_call_id: 'call_1', content: '文档内容' })
    expect(msgs[2]).toMatchObject({ role: 'user', content: '请继续' })
  })
})
