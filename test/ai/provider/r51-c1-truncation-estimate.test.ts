/**
 * R51-C-1（五十一轮）回归——OpenAI Chat 线「传输截断且无 usage」估计入账。
 *
 * 原实现：截断 error 仅在已见 usage 时随错上抛（R31-1 B-12 通道），未见 usage 走
 * 零入账——中转网关断流常连 usage 一并截掉，此形态真实消耗记 0，预算/报表系统性
 * 偏低。修复后与 anthropic（R32-1）/ responses 两线同场景恒带估计：input 按请求
 * 字符折算、output 按累计 delta 文本折算、estimated 标记估计口径（R73-1 同源公式）。
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

describe('R51-C-1：无 usage 的传输截断估计入账', () => {
  it('内容 chunk 后无任何 usage、无 finish_reason 断流 → error 带估计 usage（非零、estimated）', async () => {
    const client = {
      chat: {
        completions: {
          create: fakeSend([
            { choices: [{ delta: { content: '半截正文' }, finish_reason: null }] },
            // 流在此正常结束——无 finish_reason 也无 usage（网关断流连 usage 截掉）
          ]),
        },
      },
    } as unknown as OpenAI
    const evs = await collect(createOpenAIProvider(CONF, client), REQ)
    expect(evs.some((e) => e.type === 'done')).toBe(false)
    const err = evs.find((e) => e.type === 'error')
    expect(err).toMatchObject({ type: 'error', retryable: true, code: 'NETWORK' })
    const usage = (err as { usage?: { inputTokens: number; outputTokens: number; estimated?: boolean } }).usage
    // 修复前 usage 缺失（零入账）——回归红
    expect(usage).toBeDefined()
    expect(usage!.inputTokens).toBeGreaterThan(0)
    expect(usage!.outputTokens).toBeGreaterThan(0)
    expect(usage!.estimated).toBe(true)
  })

  it('对照：已见 usage 的截断仍按真实值上抛（R31-1 语义不回归，估计不覆盖实测）', async () => {
    const client = {
      chat: {
        completions: {
          create: fakeSend([
            { choices: [{ delta: { content: '半' }, finish_reason: null }] },
            { choices: [], usage: { prompt_tokens: 10, completion_tokens: 1 } },
          ]),
        },
      },
    } as unknown as OpenAI
    const evs = await collect(createOpenAIProvider(CONF, client), REQ)
    const err = evs.find((e) => e.type === 'error')
    expect(err).toMatchObject({
      type: 'error',
      retryable: true,
      code: 'NETWORK',
      usage: { inputTokens: 10, outputTokens: 1 },
    })
  })
})
