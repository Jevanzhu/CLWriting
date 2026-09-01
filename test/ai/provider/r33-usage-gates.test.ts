/**
 * R33-3 / R33-4（三十三轮）回归：
 * - R33-3：openai 线 usage-only chunk 先于终止事件到达（违规 include_usage 顺序的非标
 *   网关）+ 随后断流 → 此前经流末先行 emit 以 pendingStopReason 默认 'stop' 伪装成
 *   成功 done；修复后 usage 不充当完成证据，走 R1 对齐传输截断 error。合规顺序
 *   （finish_reason 先于 usage-only chunk）行为不变。
 * - R33-4：anthropic 线末条 message_delta usage 缺 output_tokens → 此前整体覆盖把
 *   已累积正确值清零；修复后逐字段 merge（末见 wins 语义保留、缺失字段继承前值）。
 */
import { describe, expect, it } from 'vitest'
import Anthropic from '@anthropic-ai/sdk'
import OpenAI from 'openai'
import { createAnthropicProvider } from '../../../src/ai/provider/anthropic-adapter.js'
import { createOpenAIProvider } from '../../../src/ai/provider/openai-adapter.js'
import type { GenEvent, GenRequest, ProviderConf } from '../../../src/ai/provider/index.js'

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

function fakeSend(events: unknown[]): () => AsyncGenerator<unknown> {
  return async function* () {
    for (const e of events) yield e
  }
}

async function collectOpenAI(client: OpenAI, req: GenRequest): Promise<GenEvent[]> {
  const out: GenEvent[] = []
  for await (const ev of createOpenAIProvider(CONF, client).stream(req, new AbortController().signal)) out.push(ev)
  return out
}

describe('R33-3: openai 线 usage-only chunk 不充当完成证据', () => {
  it('usage 块提前 + 无 finish_reason 断流 → 报传输截断错误，不发 done（修复前假 done stop）', async () => {
    const client = {
      chat: { completions: { create: fakeSend([
        { choices: [{ delta: { content: '写到一半的正文' }, finish_reason: null }] },
        { choices: [], usage: { prompt_tokens: 10, completion_tokens: 2 } }, // usage 先行
        // 随后断流：无 finish_reason chunk
      ]) } },
    } as unknown as OpenAI
    const evs = await collectOpenAI(client, { systemPrompt: '', messages: [{ role: 'user', content: 'hi' }] })
    expect(evs.find((e) => e.type === 'done')).toBeUndefined()
    expect(evs.find((e) => e.type === 'error')).toMatchObject({ retryable: true, code: 'NETWORK' })
  })

  it('合规 include_usage（finish_reason 先到、usage-only 垫后）→ done 正常带实测 usage', async () => {
    const client = {
      chat: { completions: { create: fakeSend([
        { choices: [{ delta: { content: '完整正文。' }, finish_reason: 'stop' }] },
        { choices: [], usage: { prompt_tokens: 10, completion_tokens: 2 } },
      ]) } },
    } as unknown as OpenAI
    const evs = await collectOpenAI(client, { systemPrompt: '', messages: [{ role: 'user', content: 'hi' }] })
    const done = evs.find((e) => e.type === 'done')
    expect(done).toBeDefined()
    if (done?.type !== 'done') return
    expect(done.usage).toMatchObject({ inputTokens: 10, outputTokens: 2 })
    expect(done.stopReason).toBe('stop')
    expect(done.usage.estimated).toBeUndefined()
  })
})

describe('R33-4: anthropic 线末条 delta 缺 output_tokens 不清零', () => {
  const ACONF = { ...CONF, protocol: 'anthropic' as const, auth: 'anthropic' as const } as ProviderConf

  it('两条 message_delta：首条带 output 50，末条缺该字段 → done 保留 50（修复前 0）', async () => {
    const client = {
      messages: { create: fakeSend([
        { type: 'message_start', message: { usage: { input_tokens: 100 } } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '正文' } },
        { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { input_tokens: 110, output_tokens: 50 } },
        { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { input_tokens: 110 } }, // 缺 output_tokens
      ]) },
    } as unknown as Anthropic
    const evs: GenEvent[] = []
    for await (const ev of createAnthropicProvider(ACONF, client).stream({ systemPrompt: 'sys', messages: [{ role: 'user', content: '问' }] }, new AbortController().signal)) evs.push(ev)
    const done = evs.find((e) => e.type === 'done')
    expect(done).toBeDefined()
    if (done?.type !== 'done') return
    expect(done.usage.outputTokens).toBe(50)
    expect(done.usage.inputTokens).toBe(110)
    expect(done.usage.estimated).toBeUndefined()
  })
})
