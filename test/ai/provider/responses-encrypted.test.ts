/**
 * R77-5（二十五轮批 G）：Responses 线 encrypted 推理项三码点直测。
 *
 * 缺口 11（store:false + 工具调用场景的推理延续）此前只有 w0-serialize 的出站
 * 序列化覆盖与 chat 链路间接跑过，三个 encrypted 码点无直测：
 * ① 出站：tools + gpt-5（echoReasoning=encrypted）→ include ['reasoning.encrypted_content']；
 * ② 入站：output_item.done(reasoning 携 encrypted_content) → reasoning_item 事件透出；
 * ③ 回插：assistant 轮 reasoning 块（encrypted+itemId 双条件）→ input 回插加密推理项，
 *    置于该 assistant 的产出之前（Responses 语义：reasoning item 先于其产出的调用）。
 * 假 client 按脚本吐流（capture 型，记 params——同 w0-serialize 口径）。
 */
import { describe, expect, it } from 'vitest'
import type OpenAI from 'openai'
import { createOpenAIResponsesProvider } from '../../../src/ai/provider/index.js'
import type { ChatMsg, GenEvent, GenRequest, ProviderConf } from '../../../src/ai/provider/index.js'

/** Responses 线 conf：gpt-5 走 gpt 族 quirks（echoReasoning=encrypted / toolChoiceMode=named） */
const RCONF = {
  name: 't',
  protocol: 'openai-responses' as const,
  auth: 'bearer' as const,
  baseUrl: 'https://example.local',
  model: 'gpt-5',
  apiKey: 'sk-secret',
  caps: null,
} as ProviderConf

/** 终止事件（带 message 产出项 + usage，满足 R1 判空与 done 契约） */
const COMPLETED = {
  type: 'response.completed',
  response: { output: [{ type: 'message' }], usage: { input_tokens: 1, output_tokens: 1 } },
}

/** 脚本型假 Responses client：create() 记录第一参数后按脚本吐流 */
function scriptedResponses(events: unknown[]): OpenAI & { _captured: Record<string, unknown> } {
  let captured: Record<string, unknown> = {}
  const client = {
    responses: {
      create: async function* (params: Record<string, unknown>): AsyncGenerator<unknown> {
        captured = params
        for (const ev of events) yield ev
      },
    },
  } as unknown as OpenAI
  Object.defineProperty(client, '_captured', { get: () => captured })
  return client as OpenAI & { _captured: Record<string, unknown> }
}

async function run(req: Omit<GenRequest, 'systemPrompt'> & { systemPrompt?: string }, events: unknown[] = [COMPLETED]) {
  const client = scriptedResponses(events)
  const prov = createOpenAIResponsesProvider(RCONF, client)
  const out: GenEvent[] = []
  for await (const ev of prov.stream({ systemPrompt: '', ...req }, new AbortController().signal)) out.push(ev)
  return { params: client._captured, events: out }
}

describe('R77-5 批 G：encrypted 三码点（出站 include / 入站透出 / 回合回插）', () => {
  it('① 带工具调用 → 下发 include: [reasoning.encrypted_content]（响应携带加密推理项）', async () => {
    const { params } = await run({
      messages: [{ role: 'user', content: '帮我查第5章' }],
      tools: [{ name: 'check_chapter', input_schema: { type: 'object' } }],
    })
    expect(params['include']).toEqual(['reasoning.encrypted_content'])
  })

  it('① 无工具调用 → 不发 include（非工具场景无推理延续需求）', async () => {
    const { params } = await run({ messages: [{ role: 'user', content: '你好' }] })
    expect(params['include']).toBeUndefined()
  })

  it('② output_item.done(reasoning+encrypted_content+id) → reasoning_item 事件带 itemId 透出', async () => {
    const { events } = await run(
      { messages: [{ role: 'user', content: '帮我查第5章' }] },
      [
        {
          type: 'response.output_item.done',
          item: { type: 'reasoning', id: 'rs_1', encrypted_content: 'ENC-PAYLOAD' },
        },
        COMPLETED,
      ],
    )
    expect(events.find((e) => e.type === 'reasoning_item')).toEqual({
      type: 'reasoning_item',
      encrypted: 'ENC-PAYLOAD',
      itemId: 'rs_1',
    })
  })

  it('② reasoning 项无 id → itemId 缺省透出（不炸不丢）', async () => {
    const { events } = await run(
      { messages: [{ role: 'user', content: '帮我查第5章' }] },
      [
        { type: 'response.output_item.done', item: { type: 'reasoning', encrypted_content: 'ENC-NOID' } },
        COMPLETED,
      ],
    )
    expect(events.find((e) => e.type === 'reasoning_item')).toEqual({
      type: 'reasoning_item',
      encrypted: 'ENC-NOID',
    })
  })

  it('② reasoning 项无 encrypted_content → 不透出 reasoning_item（普通推理项非载体）', async () => {
    const { events } = await run(
      { messages: [{ role: 'user', content: '帮我查第5章' }] },
      [
        { type: 'response.output_item.done', item: { type: 'reasoning', id: 'rs_plain' } },
        COMPLETED,
      ],
    )
    expect(events.some((e) => e.type === 'reasoning_item')).toBe(false)
  })

  it('③ assistant 轮 reasoning 块（encrypted+itemId 双全）→ 回插加密推理项，先于该 assistant 产出', async () => {
    const messages: ChatMsg[] = [
      { role: 'user', content: '帮我查第5章' },
      {
        role: 'assistant',
        content: [
          { type: 'reasoning', text: '', encrypted: 'ENC-A', itemId: 'rs_1' },
          { type: 'text', text: '好的' },
        ],
      },
      { role: 'user', content: '继续' },
    ]
    const { params } = await run({ messages })
    const input = params['input'] as Record<string, unknown>[]
    const reasoningIdx = input.findIndex((it) => it['type'] === 'reasoning')
    expect(reasoningIdx).toBeGreaterThanOrEqual(0)
    expect(input[reasoningIdx]).toEqual({ type: 'reasoning', id: 'rs_1', encrypted_content: 'ENC-A', summary: [] })
    // 回插位置：先于该 assistant 的 text 项（Responses 语义：reasoning item 先于其产出的 function_call）
    const assistantTextIdx = input.findIndex((it) => it['role'] === 'assistant')
    expect(assistantTextIdx).toBeGreaterThan(reasoningIdx)
  })

  it('③ 双条件收紧：缺 itemId 或缺 encrypted 的 reasoning 块都不回插', async () => {
    for (const block of [
      { type: 'reasoning' as const, text: '', encrypted: 'ENC-NO-ITEMID' },
      { type: 'reasoning' as const, text: '', itemId: 'rs_x' },
    ]) {
      const messages: ChatMsg[] = [
        { role: 'user', content: '帮我查第5章' },
        { role: 'assistant', content: [block, { type: 'text', text: '好的' }] },
        { role: 'user', content: '继续' },
      ]
      const { params } = await run({ messages })
      const input = params['input'] as Record<string, unknown>[]
      expect(input.some((it) => it['type'] === 'reasoning')).toBe(false)
    }
  })
})
