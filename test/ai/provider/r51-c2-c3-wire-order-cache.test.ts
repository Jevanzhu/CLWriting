/**
 * R51-C-2 / R51-C-3（五十一轮）回归：
 * - C-2：responses 线 user 消息 function_call_output 先出、text 后出，与 openai 线
 *   R31-6 块序对齐（此前两线相反）。当前链路 tool_result 恒独占 user 消息不触发，
 *   本用例构造混排 block 直接钉防御性契约。
 * - C-3：anthropic 线 message_delta usage 合并 cache 两档 fallback 补先前 delta 值
 *   ——非标网关「message_start 缺 cache + 首条 delta 带 cache + 末条 delta 缺」三条件
 *   叠加时，此前 cache 计量被整段丢弃（computeCallCost 缓存档计 0）。
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

async function collect(prov: ModelProvider, req: GenRequest): Promise<GenEvent[]> {
  const out: GenEvent[] = []
  for await (const ev of prov.stream(req, new AbortController().signal)) out.push(ev)
  return out
}

describe('R51-C-2: responses 线 user 消息块序（function_call_output 先于 text）', () => {
  it('混排 user 消息 → tool 输出项在前、user text 在后（与 openai 线 R31-6 同序）', async () => {
    const captured: Array<Record<string, unknown>> = []
    const client = {
      responses: {
        create: (params: Record<string, unknown>) => {
          captured.push(params)
          return (async function* () {
            yield { type: 'response.completed', response: { output: [], usage: { input_tokens: 1, output_tokens: 1 } } }
          })()
        },
      },
    } as unknown as OpenAI
    const RCONF = { ...CONF, protocol: 'openai-responses' as const } as ProviderConf
    await collect(createOpenAIResponsesProvider(RCONF, client), {
      systemPrompt: '',
      messages: [
        // 防御性契约钉子：真实链路 tool_result 恒独占 user 消息（R72-12 注），混排形态
        // 仅由本用例构造——钉住与 openai 线一致的工具优先序
        {
          role: 'user',
          content: [
            { type: 'text', text: '工具结果已就绪' },
            { type: 'tool_result', toolUseId: 'call_1', content: '结果内容' },
          ],
        },
      ],
    })
    expect(captured).toHaveLength(1)
    const input = captured[0]!['input'] as Array<Record<string, unknown>>
    const toolIdx = input.findIndex((it) => it['type'] === 'function_call_output')
    const textIdx = input.findIndex((it) => it['role'] === 'user')
    expect(toolIdx).toBeGreaterThan(-1)
    expect(textIdx).toBeGreaterThan(-1)
    expect(toolIdx).toBeLessThan(textIdx) // 修复前两序相反（text 先出）
    expect((input[toolIdx]! as Record<string, unknown>)['call_id']).toBe('call_1')
  })
})

describe('R51-C-3: anthropic message_delta 合并保留先前 delta 的 cache 计量', () => {
  const ACONF = { ...CONF, protocol: 'anthropic' as const, auth: 'anthropic' as const } as ProviderConf

  it('message_start 缺 cache + 首 delta 带 cache + 末 delta 缺 → cache 两档保留首 delta 值', async () => {
    const client = {
      messages: {
        create: () =>
          (async function* () {
            yield { type: 'message_start', message: { usage: { input_tokens: 10 } } } // 缺 cache 字段
            yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '正文产出' } }
            // 首 delta：带 cache 计量（非标网关逐 delta 回 usage 形态）
            yield {
              type: 'message_delta',
              delta: { stop_reason: 'end_turn' },
              usage: { output_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 7 },
            }
            // 末 delta：R33-4 认的 cc-switch 形态（缺 cache 字段、output 更新）
            yield { type: 'message_delta', delta: {}, usage: { output_tokens: 9 } }
          })(),
      },
    } as unknown as Anthropic
    const evs = await collect(createAnthropicProvider(ACONF, client), { systemPrompt: '', messages: [{ role: 'user', content: 'hi' }] })
    const done = evs.find((e) => e.type === 'done')
    expect(done).toBeDefined()
    if (done?.type !== 'done') return
    expect(done.usage.inputTokens).toBe(10)
    expect(done.usage.outputTokens).toBe(9) // 末 delta output 保留（R33-4 既有口径）
    // 修复点：cache 两档不再被末 delta 清丢（fallback 链补 prevUsage）
    expect(done.usage.cacheReadTokens).toBe(100)
    expect(done.usage.cacheWriteTokens).toBe(7)
    expect(done.usage.estimated).toBeUndefined() // 实测入账
  })

  it('对照：全程无 cache 计量 → 不伪造 cache 档（口径不扩大）', async () => {
    const client = {
      messages: {
        create: () =>
          (async function* () {
            yield { type: 'message_start', message: { usage: { input_tokens: 3 } } }
            yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '正文' } }
            yield { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } }
          })(),
      },
    } as unknown as Anthropic
    const evs = await collect(createAnthropicProvider(ACONF, client), { systemPrompt: '', messages: [{ role: 'user', content: 'hi' }] })
    const done = evs.find((e) => e.type === 'done')
    expect(done).toBeDefined()
    if (done?.type !== 'done') return
    expect(done.usage.inputTokens).toBe(3)
    expect(done.usage.outputTokens).toBe(2)
    expect(done.usage.cacheReadTokens).toBeUndefined()
    expect(done.usage.cacheWriteTokens).toBeUndefined()
  })
})
