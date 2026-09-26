/**
 * 适配器 cache token 记账单测（R0916-5b 拆分件，2026-09-16）。
 *
 * 拆分来源：test/ai/provider/adapter.test.ts（原「双协议适配器单测」，原头注沿革
 * 见残核 adapter.test.ts）——本件承接「D4 cache token 记账（三协议提取口径）」
 * describe 整块搬移零改动（cache 读/写量三协议提取口径 + usage 缺失/估计入账放行域）。
 */
import { describe, expect, it } from 'vitest'
import Anthropic from '@anthropic-ai/sdk'
import OpenAI from 'openai'
import { createAnthropicProvider } from '../../../src/ai/provider/anthropic-adapter.js'
import { createOpenAIProviderChat } from '../../../src/ai/provider/openai-adapter.js'
import type { ProviderConf } from '../../../src/ai/provider/index.js'
import { CONF, REQ, collect, fakeSend } from './adapter-fixtures.js'

describe('D4 cache token 记账（三协议提取口径）', () => {
  it('Anthropic：message_start 捕获 cache 读/写量，message_delta 缺字段时兜底', async () => {
    const client = {
      messages: {
        create: fakeSend([
          // Anthropic 口径：input_tokens 不含 cache，cache_read/cache_creation 独立字段
          {
            type: 'message_start',
            message: { usage: { input_tokens: 100, cache_read_input_tokens: 60, cache_creation_input_tokens: 20 } },
          },
          { type: 'message_delta', usage: { output_tokens: 5 }, delta: { stop_reason: 'end_turn' } },
        ]),
      },
    } as unknown as Anthropic
    const evs = await collect(createAnthropicProvider(CONF, client), REQ)
    expect(evs.find((e) => e.type === 'done')).toMatchObject({
      type: 'done',
      usage: { inputTokens: 100, outputTokens: 5, cacheReadTokens: 60, cacheWriteTokens: 20 },
    })
  })

  it('Anthropic：message_delta 带 cache 字段时以其为准（终值优先）', async () => {
    const client = {
      messages: {
        create: fakeSend([
          {
            type: 'message_start',
            message: { usage: { input_tokens: 100, cache_read_input_tokens: 60, cache_creation_input_tokens: 20 } },
          },
          {
            type: 'message_delta',
            usage: {
              input_tokens: 100,
              output_tokens: 5,
              cache_read_input_tokens: 80,
              cache_creation_input_tokens: 20,
            },
            delta: { stop_reason: 'end_turn' },
          },
        ]),
      },
    } as unknown as Anthropic
    const evs = await collect(createAnthropicProvider(CONF, client), REQ)
    expect(evs.find((e) => e.type === 'done')).toMatchObject({
      usage: { cacheReadTokens: 80, cacheWriteTokens: 20 },
    })
  })

  it('Anthropic：端点不发 cache 字段 → usage 无 cache 键（不造零值）', async () => {
    const client = {
      messages: {
        create: fakeSend([
          { type: 'message_start', message: { usage: { input_tokens: 10 } } },
          { type: 'message_delta', usage: { output_tokens: 2 }, delta: { stop_reason: 'end_turn' } },
        ]),
      },
    } as unknown as Anthropic
    const evs = await collect(createAnthropicProvider(CONF, client), REQ)
    const done = evs.find((e) => e.type === 'done')
    expect(done).toBeDefined()
    expect(done && 'cacheReadTokens' in done.usage).toBe(false)
  })

  it('OpenAI Chat：cached_tokens 归一——inputTokens 扣减已含的 cache 命中（M-1 勿双计成本）', async () => {
    const client = {
      chat: {
        completions: {
          create: fakeSend([
            {
              choices: [{ delta: { content: 'x' }, finish_reason: 'stop' }],
              usage: { prompt_tokens: 50, completion_tokens: 3, prompt_tokens_details: { cached_tokens: 40 } },
            },
          ]),
        },
      },
    } as unknown as OpenAI
    const evs = await collect(
      createOpenAIProviderChat(
        { ...CONF, protocol: 'openai' as const, auth: 'bearer' as const } as ProviderConf,
        client,
      ),
      REQ,
    )
    // prompt_tokens 已含 cache 命中 → inputTokens=50-40=10（Anthropic 口径），cacheReadTokens 单列；
    // 修复前 inputTokens:50 + cacheReadTokens:40 双计（成本/预算口径虚高一个命中量）
    expect(evs.find((e) => e.type === 'done')).toMatchObject({
      usage: { inputTokens: 10, outputTokens: 3, cacheReadTokens: 40 },
    })
  })

  it('OpenAI Chat：choices[0].usage 双兜底路径同样提取 cache（Kimi 形态）', async () => {
    const client = {
      chat: {
        completions: {
          create: fakeSend([
            // usage 挂在 choices[0]（§4.4 Kimi 文档矛盾形态）
            {
              choices: [
                {
                  delta: { content: 'x' },
                  finish_reason: 'stop',
                  usage: { prompt_tokens: 9, completion_tokens: 1, prompt_tokens_details: { cached_tokens: 7 } },
                },
              ],
            },
          ]),
        },
      },
    } as unknown as OpenAI
    const evs = await collect(
      createOpenAIProviderChat(
        { ...CONF, protocol: 'openai' as const, auth: 'bearer' as const } as ProviderConf,
        client,
      ),
      REQ,
    )
    expect(evs.find((e) => e.type === 'done')).toMatchObject({ usage: { cacheReadTokens: 7 } })
  })

  it('OpenAI Chat：流结束无 finish_reason 无 usage → 传输截断报错，不发 done{0,0}（R1 对齐）', async () => {
    const client = {
      chat: {
        completions: {
          // 非官方中转净空结束：有文本增量但既无 finish_reason 也无 usage chunk
          create: fakeSend([{ choices: [{ delta: { content: '半截' } }] }]),
        },
      },
    } as unknown as OpenAI
    const evs = await collect(
      createOpenAIProviderChat(
        { ...CONF, protocol: 'openai' as const, auth: 'bearer' as const } as ProviderConf,
        client,
      ),
      REQ,
    )
    // 修复前：兜底 emitDone({0,0},'stop') → 真实计费调用按成功 0 成本入账
    expect(evs.find((e) => e.type === 'done')).toBeUndefined()
    expect(evs.find((e) => e.type === 'error')).toMatchObject({ type: 'error', retryable: true, code: 'NETWORK' })
  })

  it('OpenAI Chat：有 finish_reason 无 usage（include_usage 不兼容网关）→ 估计入账放行（R73-1）', async () => {
    const client = {
      chat: {
        completions: {
          create: fakeSend([{ choices: [{ delta: { content: '完整' }, finish_reason: 'stop' }] }]),
        },
      },
    } as unknown as OpenAI
    const evs = await collect(
      createOpenAIProviderChat(
        { ...CONF, protocol: 'openai' as const, auth: 'bearer' as const } as ProviderConf,
        client,
      ),
      REQ,
    )
    // R73-1：网关完成但不回 usage——判错重试对这类网关是全量破坏，仍放行；但不再按
    // 0/0 入账（预算闸 tokens/cost 对该类端点永不生效）——input/output 按请求/产出
    // 字符折算（'hi' 与 '完整' 各 2 码位 × 0.6 → ceil = 2），estimated 标记估计口径
    expect(evs.find((e) => e.type === 'done')).toMatchObject({
      usage: { inputTokens: 2, outputTokens: 2, estimated: true },
      stopReason: 'stop',
    })
    expect(evs.find((e) => e.type === 'error')).toBeUndefined()
  })
})
