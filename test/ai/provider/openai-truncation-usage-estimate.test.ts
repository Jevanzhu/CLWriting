/**
 * OpenAI Chat 线「传输截断」终止契约与入账三源并一案（按被测行为合并；断言逐条
 * 保留、零去重——后两源的 usage 先行 / 末见 wins 两臂为并入时新增锚）：
 * - r51-c1-truncation-estimate.test.ts（R51-C-1：无 usage 的传输截断估计入账——截断
 *   error 仅在已见 usage 时随错上抛（R31-1 B-12 通道），未见 usage 零入账——中转网关
 *   断流常连 usage 一并截掉，真实消耗记 0。修复后与 anthropic（R32-1）/ responses 两线
 *   同场景恒带估计：input 按请求字符折算、output 按累计 delta 文本折算、estimated 标记
 *   （R73-1 同源公式））
 * - backlog-openai-trunc-tool-accum.test.ts（R55-C-3：估计折算并入 toolAccum 残留，
 *   对齐 anthropic jsonBuf / responses args 两线口径——「断流 + 在途工具调用」复合
 *   形态 output 系统性低估；tool 事件仍不 flush（R26-25 取舍不变））
 * - r31a-openai-truncation.test.ts（R31-1：有 usage 无 finish_reason 的截断流不得按
 *   正常完成（done）出场——须发传输截断 error（retryable）且已见 usage 随错上抛
 *   （B-12 通道，截断不丢计费）。对照 usage 先行的网关形态（Kimi 文档 §4.4，usage 可
 *   在 choices[0] 随任意 chunk 出现）此前会在 finish_reason 之前断流时把半截文本按
 *   stopReason:'stop' 正常完成落盘。2026-09-26 终扫并入）
 */
import { describe, expect, it } from 'vitest'
import OpenAI from 'openai'
import { createOpenAIProviderChat } from '../../../src/ai/provider/openai-adapter.js'
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
const REQ_TOOL: GenRequest = { systemPrompt: '', messages: [{ role: 'user', content: '查一下' }] }

async function collect(prov: ReturnType<typeof createOpenAIProviderChat>, req: GenRequest): Promise<GenEvent[]> {
  const out: GenEvent[] = []
  for await (const ev of prov.stream(req, new AbortController().signal)) out.push(ev)
  return out
}

function fakeSend(events: unknown[]): () => AsyncGenerator<unknown> {
  return async function* () {
    for (const e of events) yield e
  }
}

describe('R51-C-1：无 usage 的传输截断估计入账（纯文本）', () => {
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
    const evs = await collect(createOpenAIProviderChat(CONF, client), REQ)
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
    const evs = await collect(createOpenAIProviderChat(CONF, client), REQ)
    const err = evs.find((e) => e.type === 'error')
    expect(err).toMatchObject({
      type: 'error',
      retryable: true,
      code: 'NETWORK',
      usage: { inputTokens: 10, outputTokens: 1 },
    })
  })
})

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
    const evs = await collect(createOpenAIProviderChat(CONF, client), REQ_TOOL)
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
})

// ── R31-1（三十一轮，2026-09-26 终扫自 r31a-openai-truncation.test.ts 并入）：
// 「有 usage 无 finish_reason」= 传输截断，不得按正常完成出场 ─────────────────────
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
    const evs = await collect(createOpenAIProviderChat(CONF, client), REQ)
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
    const evs = await collect(createOpenAIProviderChat(CONF, client), REQ)
    const done = evs.find((e) => e.type === 'done')
    expect(done).toMatchObject({ type: 'done', usage: { inputTokens: 7, outputTokens: 3 }, stopReason: 'stop' })
  })
})
