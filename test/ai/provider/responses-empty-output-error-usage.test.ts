/**
 * R34D-8（三十四轮）回归——Responses 线 completed 空产出 error 事件随错上抛 usage：
 *
 * completed 无 message/function_call 产出且未 yield 过 tool → 退化完成判错（R1 判空）。
 * 该 error 事件原不带 usage，与同文件另四条错误路径（incomplete 非 max_output_tokens /
 * response.failed / 流中裸 error / 无终止事件截断）的 R32-2 口径不一致。修后补齐：
 * 上游 r.usage 在手即真值，否则走 R74-1 估计入账兜底（标 estimated）。
 */
import { describe, expect, it } from 'vitest'
import OpenAI from 'openai'
import { createOpenAIResponsesProvider } from '../../../src/ai/provider/responses-adapter.js'
import type { GenEvent, GenRequest, ProviderConf } from '../../../src/ai/provider/index.js'

const RCONF: ProviderConf = {
  id: 't1',
  name: 't',
  protocol: 'openai-responses',
  auth: 'anthropic',
  baseUrl: 'https://example.local',
  model: 'gpt-5',
  apiKey: 'sk-secret-key',
  caps: null,
} as ProviderConf

const REQ: GenRequest = { systemPrompt: '', messages: [{ role: 'user', content: 'hi' }] }

async function collect(prov: { stream(req: GenRequest, signal: AbortSignal): AsyncIterable<GenEvent> }, req: GenRequest): Promise<GenEvent[]> {
  const out: GenEvent[] = []
  for await (const ev of prov.stream(req, new AbortController().signal)) out.push(ev)
  return out
}

function fakeResponsesClient(events: unknown[]): OpenAI {
  return {
    responses: {
      create: async (): Promise<AsyncGenerator<unknown>> =>
        (async function* () {
          for (const e of events) yield e
        })(),
    },
  } as unknown as OpenAI
}

describe('R34D-8：completed 空产出 error 随错上抛 usage', () => {
  it('completed 无内容项且 response.usage 在手 → error 携上游真值', async () => {
    const client = fakeResponsesClient([
      // 空 output 数组、无任何前置 delta/tool → R1 判空分支；usage 是真实计费面
      { type: 'response.completed', response: { output: [], usage: { input_tokens: 21, output_tokens: 0 } } },
    ])
    const evs = await collect(createOpenAIResponsesProvider(RCONF, client), REQ)
    expect(evs.some((e) => e.type === 'done')).toBe(false)
    const err = evs.find((e) => e.type === 'error') as Extract<GenEvent, { type: 'error' }> | undefined
    expect(err).toBeDefined()
    expect(err?.message).toContain('空产出')
    expect(err?.usage).toMatchObject({ inputTokens: 21, outputTokens: 0 })
  })

  it('completed 无内容项且无 usage → error 携估计值（estimated，input 按请求折算）', async () => {
    const client = fakeResponsesClient([
      { type: 'response.completed', response: {} },
    ])
    const evs = await collect(createOpenAIResponsesProvider(RCONF, client), REQ)
    expect(evs.some((e) => e.type === 'done')).toBe(false)
    const err = evs.find((e) => e.type === 'error') as Extract<GenEvent, { type: 'error' }> | undefined
    expect(err?.usage).toBeDefined()
    expect(err?.usage?.inputTokens).toBeGreaterThan(0)
    expect(err?.usage?.estimated).toBe(true)
  })
})
