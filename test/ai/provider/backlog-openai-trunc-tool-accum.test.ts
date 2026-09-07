/**
 * R59 清偿批（R55-C-3）回归：OpenAI 线「未见 usage 的传输截断」估计折算并入
 * toolAccum 残留（对齐 anthropic jsonBuf / responses args 两线口径）。
 *
 * 原实现只按 delta 文本（outText）折算——「断流 + 在途工具调用」复合形态（tool_call
 * 分片后无 finish_reason 直接断流）output 估计系统性小幅低估。修复后 tool 残留
 * （name+argsBuf）并入折算；tool 事件仍不 flush（R26-25 取舍不变：gen 层遇 error
 * 必弃事件，只修估计入账面）。
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

const REQ: GenRequest = { systemPrompt: '', messages: [{ role: 'user', content: '查一下' }] }

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

describe('R55-C-3：截断估计并入 toolAccum 残留', () => {
  it('tool_call 分片后断流（无 finish_reason/usage）→ 估计 output 含工具参数折算（非零）', async () => {
    const longArgs = `{"query":"${'北境雪线'.repeat(10)}"}`
    const client = {
      chat: {
        completions: {
          create: fakeSend([
            { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'book_search', arguments: '' } }] }, finish_reason: null }] },
            // 流在此正常结束——无 finish_reason 也无 usage（网关断流），toolAccum 残留在途调用
            { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: longArgs } }] }, finish_reason: null }] },
          ]),
        },
      },
    } as unknown as OpenAI
    const evs = await collect(createOpenAIProvider(CONF, client), REQ)
    expect(evs.some((e) => e.type === 'done')).toBe(false)
    // R26-25 取舍不变：截断分支 tool 事件仍不 flush
    expect(evs.some((e) => e.type === 'tool')).toBe(false)
    const err = evs.find((e) => e.type === 'error')
    expect(err).toMatchObject({ type: 'error', retryable: true, code: 'NETWORK' })
    const usage = (err as { usage?: { outputTokens: number; estimated?: boolean } }).usage
    expect(usage).toBeDefined()
    expect(usage!.estimated).toBe(true)
    // 修复前：outText 为空 → outputTokens = 0（低估）；修复后 tool 残留（name+argsBuf）
    // 并入折算 → > 0（与 anthropic/responses 两线口径一致）
    expect(usage!.outputTokens).toBeGreaterThan(0)
  })

  it('无工具残留的纯文本断流：估计行为不变（output 仍按 delta 文本折算）', async () => {
    const client = {
      chat: {
        completions: {
          create: fakeSend([
            { choices: [{ delta: { content: '半截正文' }, finish_reason: null }] },
          ]),
        },
      },
    } as unknown as OpenAI
    const evs = await collect(createOpenAIProvider(CONF, client), REQ)
    const err = evs.find((e) => e.type === 'error')
    const usage = (err as { usage?: { outputTokens: number; estimated?: boolean } }).usage
    expect(usage).toBeDefined()
    expect(usage!.estimated).toBe(true)
    expect(usage!.outputTokens).toBeGreaterThan(0)
  })
})
