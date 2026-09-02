/**
 * R37-2（三十七轮批 A）回归——openai 线流解析对 `delta: null` 空 chunk 的容错。
 *
 * 缺陷：流解析段 `delta?.content`（:353）与 reasoning 分支（:360）均用可选链，唯独
 * tool_calls 分支 `if (delta.tool_calls)`（:367）漏——部分网关下发 `delta: null` 的空
 * chunk（如纯 usage 载荷前的占位）时直接 TypeError，整条流崩断成 GEN_FAIL。修复后
 * 可选链兜底：空 chunk 跳过，前后 chunk 的文本/tool_calls 累积与 usage 入账不受影响。
 */
import { describe, expect, it } from 'vitest'
import OpenAI from 'openai'
import { createOpenAIProviderChat } from '../../../src/ai/provider/openai-adapter.js'
import type { GenEvent, GenRequest, ProviderConf } from '../../../src/ai/provider/index.js'

const CONF = {
  id: 't1',
  name: 't',
  protocol: 'openai' as const,
  auth: 'bearer' as const,
  baseUrl: 'https://example.local',
  model: 'test-model',
  apiKey: 'sk-secret-key',
  caps: null,
} as ProviderConf

const REQ: GenRequest = { systemPrompt: '', messages: [{ role: 'user', content: 'hi' }] }

async function collect(req: GenRequest, events: unknown[]): Promise<GenEvent[]> {
  const client = {
    chat: {
      completions: {
        create: async (): Promise<AsyncGenerator<unknown>> =>
          (async function* () {
            for (const e of events) yield e
          })(),
      },
    },
  } as unknown as OpenAI
  const out: GenEvent[] = []
  for await (const ev of createOpenAIProviderChat(CONF, client).stream(req, new AbortController().signal)) {
    out.push(ev)
  }
  return out
}

describe('R37-2: delta:null 空 chunk 不崩流', () => {
  it('tool_calls 累积中途夹 delta:null chunk → 不抛错，前后分片照常拼装，usage 入账', async () => {
    const evs = await collect(
      { ...REQ, tools: [{ name: 'submit_chapter', description: '', input_schema: { type: 'object' } }] },
      [
        { choices: [{ delta: { tool_calls: [{ id: 'call_1', function: { name: 'submit_chapter', arguments: '{"正文":' } }] }, finish_reason: null }] },
        // 部分网关的空占位 chunk：choice 在场但 delta 为 null（修复前此处 TypeError 崩流）
        { choices: [{ delta: null, finish_reason: null }] },
        { choices: [{ delta: { tool_calls: [{ function: { arguments: '"全文"}' } }] }, finish_reason: 'tool_calls' }] },
        { choices: [], usage: { prompt_tokens: 12, completion_tokens: 6 } },
      ],
    )
    // 修复前：TypeError → error 事件，tool/done 全丢
    expect(evs.some((e) => e.type === 'error')).toBe(false)
    expect(evs.find((e) => e.type === 'tool')).toMatchObject({
      type: 'tool',
      id: 'call_1',
      name: 'submit_chapter',
      input: { 正文: '全文' },
    })
    expect(evs.find((e) => e.type === 'done')).toMatchObject({ type: 'done', usage: { inputTokens: 12, outputTokens: 6 } })
  })

  it('纯文本流夹 delta:null chunk → 文本增量照常、finish 照常收口', async () => {
    const evs = await collect(REQ, [
      { choices: [{ delta: { content: '第一' }, finish_reason: null }] },
      { choices: [{ delta: null, finish_reason: null }] },
      { choices: [{ delta: { content: '段' }, finish_reason: 'stop' }] },
      { choices: [], usage: { prompt_tokens: 3, completion_tokens: 2 } },
    ])
    expect(evs.some((e) => e.type === 'error')).toBe(false)
    expect(evs.filter((e) => e.type === 'text')).toEqual([
      { type: 'text', delta: '第一' },
      { type: 'text', delta: '段' },
    ])
    expect(evs.find((e) => e.type === 'done')).toMatchObject({ type: 'done', usage: { inputTokens: 3, outputTokens: 2 } })
  })
})
