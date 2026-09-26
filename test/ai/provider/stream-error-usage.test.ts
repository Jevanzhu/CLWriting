/**
 * 流中 SDK 异常随错上抛 usage（R0917-6-P3-4，2026-09-17 全库源码重评六轮修复批）。
 *
 * 缺陷形态：B-12/R31-1 的「usage 随错上抛」只覆盖适配器**主动 yield** 的 error 事件
 * （截断 / refusal / content_filter 均带）；SDK 在流消费中直接 throw（mid-stream 连接
 * 重置等）走 `toErrorEvent(e)` 无 usage 通道——message_start 已实测的 input/cache、
 * 流内产出累计全部随异常蒸发，runner 终态失败按 0 入账（真实消耗漏记）。
 *
 * 修复口径：makeToErrorEvent 加可选 usage 第二参（缺省时输出与改前逐字节一致）；
 * 三适配器 catch 分支在**已开始消费流**时把「异常时点可得的最小估计」折算后传入。
 * 未消费（建连期异常）不上抛——那时无任何消耗，估计即虚报。
 *
 * 三线各两例（已消费带 usage / 未消费不带 usage），与 ii-1「消费后不重跑」同源判据。
 */
import { describe, expect, it } from 'vitest'
import Anthropic from '@anthropic-ai/sdk'
import OpenAI from 'openai'
import { createAnthropicProvider } from '../../../src/ai/provider/anthropic-adapter.js'
import { createOpenAIProviderChat } from '../../../src/ai/provider/openai-adapter.js'
import { createOpenAIResponsesProvider } from '../../../src/ai/provider/responses-adapter.js'
import type { GenEvent, ModelProvider } from '../../../src/ai/provider/index.js'
import { CONF, REQ, collect } from './adapter-fixtures.js'

const RCONF = { ...CONF, protocol: 'openai-responses' as const, model: 'gpt-5' }

/** 先吐若干事件、再抛 SDK 连接错误（mid-stream 断流的确定性模拟）。 */
function throwAfter(events: unknown[], err: unknown): () => AsyncGenerator<unknown> {
  return async function* () {
    for (const e of events) yield e
    throw err
  }
}

function findError(evs: GenEvent[]): Extract<GenEvent, { type: 'error' }> | undefined {
  return evs.find((e) => e.type === 'error') as Extract<GenEvent, { type: 'error' }> | undefined
}

describe('anthropic 线：流中 SDK 抛错随错上抛 usage', () => {
  it('message_start 后断流 → error 带 usage（实测 input/cache + 估计 output，标 estimated）', async () => {
    const client = {
      messages: {
        create: throwAfter(
          [
            {
              type: 'message_start',
              message: { usage: { input_tokens: 11, cache_read_input_tokens: 5, cache_creation_input_tokens: 2 } },
            },
            { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
            { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '半截正文' } },
          ],
          new Anthropic.APIConnectionError({ message: 'Connection error.' }),
        ),
      },
    } as unknown as Anthropic
    const evs = await collect(createAnthropicProvider(CONF, client), REQ)
    const err = findError(evs)
    expect(err).toBeDefined()
    expect(err).toMatchObject({ retryable: true, code: 'NETWORK' })
    expect(err?.usage).toMatchObject({ inputTokens: 11, cacheReadTokens: 5, cacheWriteTokens: 2, estimated: true })
    expect(err?.usage?.outputTokens).toBeGreaterThan(0)
  })

  it('建连期就抛错（未消费流）→ error 不带 usage（无消耗不得虚报）', async () => {
    const client = {
      messages: {
        create: (): never => {
          throw new Anthropic.APIConnectionError({ message: 'Connection error.' })
        },
      },
    } as unknown as Anthropic
    const evs = await collect(createAnthropicProvider(CONF, client), REQ)
    const err = findError(evs)
    expect(err).toBeDefined()
    expect(err?.code).toBe('NETWORK')
    expect(err?.usage).toBeUndefined()
  })
})

describe('openai chat 线：流中 SDK 抛错随错上抛 usage', () => {
  it('已见 usage chunk 后断流 → error 带该实测 usage（真值优先，非估计）', async () => {
    const client = {
      chat: {
        completions: {
          create: throwAfter(
            [
              { choices: [{ delta: { content: '半截' }, finish_reason: null }] },
              // usage-only chunk（choices 缺省）——chat 线记 latestUsage 的两条路径之一
              //（另一条 = finish_reason chunk 自带 usage）；delta 与 usage 同 chunk 的
              // 形态不记（见 openai-adapter 的 `if (!choice)` 分支）
              { usage: { prompt_tokens: 20, completion_tokens: 6 } },
            ],
            new OpenAI.APIConnectionError({ message: 'Connection error.' }),
          ),
        },
      },
    } as unknown as OpenAI
    const evs = await collect(createOpenAIProviderChat(CONF, client), REQ)
    const err = findError(evs)
    expect(err).toBeDefined()
    expect(err).toMatchObject({ retryable: true, code: 'NETWORK' })
    // latestUsage 在手 → toUsage 直出；无 estimated 标记（实测值非估计口径）
    expect(err?.usage).toMatchObject({ inputTokens: 20, outputTokens: 6 })
    expect(err?.usage?.estimated).toBeUndefined()
  })

  it('未见过 usage 但已产出 delta → error 带估计 usage（estimated）', async () => {
    const client = {
      chat: {
        completions: {
          create: throwAfter(
            [{ choices: [{ delta: { content: '一段已经产生的正文内容' }, finish_reason: null }] }],
            new OpenAI.APIConnectionError({ message: 'Connection error.' }),
          ),
        },
      },
    } as unknown as OpenAI
    const evs = await collect(createOpenAIProviderChat(CONF, client), REQ)
    const err = findError(evs)
    expect(err?.usage).toBeDefined()
    expect(err?.usage?.estimated).toBe(true)
    expect(err?.usage?.outputTokens).toBeGreaterThan(0)
    expect(err?.usage?.inputTokens).toBeGreaterThan(0)
  })

  it('建连期就抛错（未消费流）→ error 不带 usage', async () => {
    const client = {
      chat: {
        completions: {
          create: (): never => {
            throw new OpenAI.APIConnectionError({ message: 'Connection error.' })
          },
        },
      },
    } as unknown as OpenAI
    const evs = await collect(createOpenAIProviderChat(CONF, client), REQ)
    const err = findError(evs)
    expect(err).toBeDefined()
    expect(err?.usage).toBeUndefined()
  })
})

describe('openai responses 线：流中 SDK 抛错随错上抛 usage', () => {
  it('已产出 delta 后断流 → error 带估计 usage（estimated）', async () => {
    const client = {
      responses: {
        create: throwAfter(
          [{ type: 'response.output_text.delta', delta: '半截正文内容' }],
          new OpenAI.APIConnectionError({ message: 'Connection error.' }),
        ),
      },
    } as unknown as OpenAI
    const evs = await collect(createOpenAIResponsesProvider(RCONF, client), REQ)
    const err = findError(evs)
    expect(err).toBeDefined()
    expect(err).toMatchObject({ retryable: true, code: 'NETWORK' })
    expect(err?.usage).toBeDefined()
    expect(err?.usage?.estimated).toBe(true)
    expect(err?.usage?.outputTokens).toBeGreaterThan(0)
  })

  it('建连期就抛错（未消费流）→ error 不带 usage', async () => {
    const client = {
      responses: {
        create: (): never => {
          throw new OpenAI.APIConnectionError({ message: 'Connection error.' })
        },
      },
    } as unknown as OpenAI
    const evs = await collect(createOpenAIResponsesProvider(RCONF, client), REQ)
    const err = findError(evs)
    expect(err).toBeDefined()
    expect(err?.usage).toBeUndefined()
  })
})

describe('usage 载荷为加性：缺省第二参输出与改前逐字节一致', () => {
  it('适配器成功路径不受影响（done 正常 emit，无 error 事件）', async () => {
    const client = {
      messages: {
        create: async function* () {
          yield { type: 'message_start', message: { usage: { input_tokens: 3 } } }
          yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '好' } }
          yield { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } }
        },
      },
    } as unknown as Anthropic
    const evs: GenEvent[] = await collect(createAnthropicProvider(CONF, client) as ModelProvider, REQ)
    expect(evs.some((e) => e.type === 'error')).toBe(false)
    const done = evs.find((e) => e.type === 'done')
    expect(done).toBeDefined()
    if (done && done.type === 'done') expect(done.usage).toMatchObject({ inputTokens: 3, outputTokens: 2 })
  })
})
