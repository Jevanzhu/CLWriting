/**
 * R35 第三十五轮评审修复批 A（provider 线）回归：
 *
 * - R35-18：Responses 线伪流式网关（接受 stream 参数但只回终态、delta 事件全缺）——
 *   completed 终态时从 message item 回填 text，使该形态可用；无内容产出的空产出
 *   报错路径保持不变；有 delta 流出时不回填（防重复增量）。
 * - R35-19：OpenAI Chat 线 usage 补读 completion_tokens_details.reasoning_tokens
 *   （与 responses 线 output_tokens_details 对齐的推理 token 观测位）。
 */
import { describe, expect, it } from 'vitest'
import OpenAI from 'openai'
import { createOpenAIProvider } from '../../../src/ai/provider/openai-adapter.js'
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

/** 伪网关流：客户端返回 async generator（r74-usage-fixes.test.ts 同款手法） */
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

describe('R35-18: Responses 伪流式（只回终态）completed 从 message item 回填 text', () => {
  const RCONF = { ...CONF, protocol: 'openai-responses' as const } as ProviderConf

  it('delta 全缺 + completed 带 message item → text 回填整段产出，done 正常实测入账', async () => {
    const client = {
      responses: {
        create: fakeSend([
          {
            type: 'response.completed',
            response: {
              output: [{ type: 'message', content: [{ type: 'output_text', text: '伪流式网关只回终态的整段产出。' }] }],
              usage: { input_tokens: 9, output_tokens: 7 },
            },
          },
        ]),
      },
    } as unknown as OpenAI
    const evs = await collect(createOpenAIResponsesProvider(RCONF, client), {
      systemPrompt: '',
      messages: [{ role: 'user', content: 'hi' }],
    })
    // 修复前：零 delta → 零产出，done 空文本按成功出场（gen 侧 text:''）
    const texts = evs.filter((e) => e.type === 'text')
    expect(texts).toHaveLength(1)
    expect((texts[0] as { delta: string }).delta).toBe('伪流式网关只回终态的整段产出。')
    const done = evs.find((e) => e.type === 'done')
    expect(done).toMatchObject({ type: 'done', stopReason: 'stop', usage: { inputTokens: 9, outputTokens: 7 } })
    if (done?.type !== 'done') return
    expect(done.usage.estimated).toBeUndefined()
  })

  it('delta 全缺且 output 无内容项（真实空产出）→ 维持空产出报错，不静默成功', async () => {
    const client = {
      responses: {
        create: fakeSend([
          { type: 'response.completed', response: { output: [], usage: { input_tokens: 3, output_tokens: 1 } } },
        ]),
      },
    } as unknown as OpenAI
    const evs = await collect(createOpenAIResponsesProvider(RCONF, client), {
      systemPrompt: '',
      messages: [{ role: 'user', content: 'hi' }],
    })
    expect(evs.at(-1)?.type).toBe('error')
    expect(evs.some((e) => e.type === 'done')).toBe(false)
  })

  it('有 delta 流出时不回填（防重复增量）——既有流式形态行为不变', async () => {
    const client = {
      responses: {
        create: fakeSend([
          { type: 'response.output_text.delta', delta: '增量正文。' },
          {
            type: 'response.completed',
            response: {
              output: [{ type: 'message', content: [{ type: 'output_text', text: '增量正文。' }] }],
              usage: { input_tokens: 3, output_tokens: 2 },
            },
          },
        ]),
      },
    } as unknown as OpenAI
    const evs = await collect(createOpenAIResponsesProvider(RCONF, client), {
      systemPrompt: '',
      messages: [{ role: 'user', content: 'hi' }],
    })
    const texts = evs.filter((e) => e.type === 'text')
    expect(texts).toHaveLength(1) // 不叠加 message item 同文
    expect((texts[0] as { delta: string }).delta).toBe('增量正文。')
    expect(evs.some((e) => e.type === 'done')).toBe(true)
  })
})

describe('R35-19: OpenAI Chat 线读取 completion_tokens_details.reasoning_tokens', () => {
  it('usage 尾包带 reasoning_tokens → done.usage 透传（cache 扣减口径不变）', async () => {
    const client = {
      chat: {
        completions: {
          create: fakeSend([
            { choices: [{ index: 0, delta: { content: '正文' }, finish_reason: null }] },
            { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
            {
              choices: [],
              usage: {
                prompt_tokens: 30,
                completion_tokens: 20,
                prompt_tokens_details: { cached_tokens: 10 },
                completion_tokens_details: { reasoning_tokens: 8 },
              },
            },
          ]),
        },
      },
    } as unknown as OpenAI
    const evs = await collect(createOpenAIProvider(CONF, client), {
      systemPrompt: '',
      messages: [{ role: 'user', content: 'hi' }],
    })
    // 修复前：reasoningTokens 缺失（Chat 线不读该观测位，与 responses/anthropic 线不对齐）
    expect(evs.find((e) => e.type === 'done')).toMatchObject({
      usage: { inputTokens: 20, outputTokens: 20, cacheReadTokens: 10, reasoningTokens: 8 },
    })
  })
})
