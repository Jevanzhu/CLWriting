/**
 * R33D（三十三轮）批 A 回归——AI 链路四件：
 *
 * - R33D-2：openai 线 finish_reason='content_filter' / anthropic 线 stop_reason='refusal'
 *   不得按正常 done 出场（半截正文按成功落稿三线分叉闭合）——error（PROTOCOL，不可重试）
 *   且 usage 随错上抛（B-12 通道）。
 * - R33D-11：withFirstByteTimeout 任意退出路径关源迭代器——消费方收到 error 事件 throw
 *   后，源生成器的 finally 必须执行（原实现源停在 yield 上悬挂 SDK 流）。
 * - R33D-12：responses done 项 call_id/id 双缺 → 兜底序号 id（不再产出空串 tool id）。
 */
import { describe, expect, it } from 'vitest'
import Anthropic from '@anthropic-ai/sdk'
import OpenAI from 'openai'
import { createAnthropicProvider } from '../../../src/ai/provider/anthropic-adapter.js'
import { createOpenAIProvider } from '../../../src/ai/provider/openai-adapter.js'
import { createOpenAIResponsesProvider } from '../../../src/ai/provider/responses-adapter.js'
import { withFirstByteTimeout } from '../../../src/ai/gen.js'
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

async function collect(prov: { stream(req: GenRequest, signal: AbortSignal): AsyncIterable<GenEvent> }, req: GenRequest): Promise<GenEvent[]> {
  const out: GenEvent[] = []
  for await (const ev of prov.stream(req, new AbortController().signal)) out.push(ev)
  return out
}

function fakeSend(events: unknown[]): () => AsyncGenerator<unknown> {
  return async function* () {
    for (const e of events) yield e
  }
}

function findError(evs: GenEvent[]): Extract<GenEvent, { type: 'error' }> | undefined {
  return evs.find((e) => e.type === 'error') as Extract<GenEvent, { type: 'error' }> | undefined
}

describe('R33D-2：content_filter / refusal 不再伪装正常完成', () => {
  it('openai：finish_reason=content_filter 带 usage → error PROTOCOL（无 done，usage 上抛）', async () => {
    const client = {
      chat: {
        completions: {
          create: fakeSend([
            { choices: [{ delta: { content: '半截' }, finish_reason: null }] },
            { choices: [{ delta: {}, finish_reason: 'content_filter' }], usage: { prompt_tokens: 8, completion_tokens: 2 } },
          ]),
        },
      },
    } as unknown as OpenAI
    const evs = await collect(createOpenAIProvider(CONF, client), REQ)
    expect(evs.some((e) => e.type === 'done')).toBe(false)
    const err = findError(evs)
    expect(err).toMatchObject({ type: 'error', retryable: false, code: 'PROTOCOL' })
    if (err) expect(err.message).toContain('content_filter')
    expect(err?.usage).toMatchObject({ inputTokens: 8, outputTokens: 2 })
  })

  it('openai：content_filter 无 usage → error 携估计 usage（不落 done）', async () => {
    const client = {
      chat: {
        completions: {
          create: fakeSend([
            { choices: [{ delta: { content: '半截' }, finish_reason: null }] },
            { choices: [{ delta: {}, finish_reason: 'content_filter' }] },
          ]),
        },
      },
    } as unknown as OpenAI
    const evs = await collect(createOpenAIProvider(CONF, client), REQ)
    expect(evs.some((e) => e.type === 'done')).toBe(false)
    const err = findError(evs)
    expect(err?.usage?.inputTokens).toBeGreaterThan(0)
    expect(err?.usage?.outputTokens).toBeGreaterThan(0)
  })

  it('anthropic：stop_reason=refusal 带 usage → error PROTOCOL（无 done，usage 上抛）', async () => {
    const client = {
      messages: {
        create: fakeSend([
          { type: 'message_start', message: { usage: { input_tokens: 11 } } },
          { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
          { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '半截' } },
          { type: 'content_block_stop', index: 0 },
          { type: 'message_delta', delta: { stop_reason: 'refusal' }, usage: { output_tokens: 3 } },
        ]),
      },
    } as unknown as Anthropic
    const evs = await collect(createAnthropicProvider(CONF, client), REQ)
    expect(evs.some((e) => e.type === 'done')).toBe(false)
    const err = findError(evs)
    expect(err).toMatchObject({ type: 'error', retryable: false, code: 'PROTOCOL' })
    if (err) expect(err.message).toContain('refusal')
    expect(err?.usage).toMatchObject({ inputTokens: 11, outputTokens: 3 })
  })

  it('anthropic：refusal 无 usage（连 message_start 都缺）→ error 携估计 usage', async () => {
    const client = {
      messages: {
        create: fakeSend([
          { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
          { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '半截' } },
          // message_delta 不带 usage 字段（无 message_start）→ latestUsage 为 null → 估计分支
          { type: 'message_delta', delta: { stop_reason: 'refusal' } },
        ]),
      },
    } as unknown as Anthropic
    // 折算系数按字符量估计——REQ 太短估出 0，用足够长的输入验证非零估计
    const longReq: GenRequest = { systemPrompt: '', messages: [{ role: 'user', content: '请写一段足够长的正文来验证折算估计。'.repeat(20) }] }
    const evs = await collect(createAnthropicProvider(CONF, client), longReq)
    expect(evs.some((e) => e.type === 'done')).toBe(false)
    const err = findError(evs)
    expect(err?.usage?.inputTokens).toBeGreaterThan(0)
    expect(err?.usage?.estimated).toBe(true)
  })

  it('对照：正常 stop_reason（end_turn/stop）行为不变（无回归）', async () => {
    const anthropicClient = {
      messages: {
        create: fakeSend([
          { type: 'message_start', message: { usage: { input_tokens: 5 } } },
          { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '好' } },
          { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } },
        ]),
      },
    } as unknown as Anthropic
    const evs = await collect(createAnthropicProvider(CONF, anthropicClient), REQ)
    expect(evs.some((e) => e.type === 'done')).toBe(true)
    expect(evs.some((e) => e.type === 'error')).toBe(false)
  })
})

describe('R33D-11：withFirstByteTimeout 任意退出路径关源', () => {
  it('消费方收到 error 事件 throw → 源生成器 finally 执行（不再悬挂）', async () => {
    let sourceClosed = false
    async function* source(): AsyncGenerator<GenEvent> {
      try {
        yield { type: 'error', message: 'boom', retryable: false, code: 'PROTOCOL' } as GenEvent
        // 消费方 throw 后本生成器应被 return()——下方挂起点不得到达
        await new Promise(() => {})
      } finally {
        sourceClosed = true
      }
    }
    const wrapper = withFirstByteTimeout(source(), 60_000)
    const evs: GenEvent[] = []
    await expect(async () => {
      for await (const ev of wrapper) {
        evs.push(ev)
        if (ev.type === 'error') throw new Error('consumer abort on error event')
      }
    }).rejects.toThrow('consumer abort')
    expect(evs).toHaveLength(1)
    // 给不等待的 return() 一个微任务冲刷
    await new Promise((r) => setImmediate(r))
    expect(sourceClosed).toBe(true)
  })

  it('正常消费完（done 事件自然收束）→ 源关闭语义不变', async () => {
    let sourceClosed = false
    async function* source(): AsyncGenerator<GenEvent> {
      try {
        yield { type: 'text', delta: 'a' } as GenEvent
        yield { type: 'done', stopReason: 'stop', usage: { inputTokens: 1, outputTokens: 1 } } as GenEvent
      } finally {
        sourceClosed = true
      }
    }
    const evs: GenEvent[] = []
    for await (const ev of withFirstByteTimeout(source(), 60_000)) evs.push(ev)
    expect(evs).toHaveLength(2)
    expect(sourceClosed).toBe(true)
  })
})

describe('R33D-12：responses done 项双缺 id → 兜底序号 id', () => {
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

  it('done 项 call_id/id 双缺 → tool 事件 id 为 call_N 非空串', async () => {
    const client = fakeResponsesClient([
      { type: 'response.output_item.added', output_index: 0, item: { type: 'function_call' } },
      { type: 'response.function_call_arguments.delta', item_id: '', output_index: 0, delta: '{"q":1}' },
      { type: 'response.output_item.done', output_index: 0, item: { type: 'function_call', name: 'search' } },
      { type: 'response.completed', response: { output: [{ type: 'message' }], usage: { input_tokens: 1, output_tokens: 1 } } },
    ])
    const evs = await collect(createOpenAIResponsesProvider({ ...CONF, protocol: 'openai-responses', model: 'gpt-5' }, client), REQ)
    const tool = evs.find((e) => e.type === 'tool') as Extract<GenEvent, { type: 'tool' }> | undefined
    expect(tool).toBeDefined()
    expect(tool!.id).toBeTruthy()
    expect(tool!.id).toMatch(/^call_/)
  })
})
