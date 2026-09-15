/**
 * 双协议适配器单测（审查 §七：两个适配器零单测）。
 *
 * 注入假 SDK 客户端 → 验证协议事件翻译成统一 GenEvent：
 * text 增量 / tool_use input_json_delta 增量拼装 / usage 提取 / done 幂等 /
 * APIError → retryable 归因（429/5xx）/ AbortError → 「已中断」。
 *
 * 拆分沿革（R0916-5b，2026-09-16）：原 1475 行按 describe 域拆为五件——
 * adapter-openai.test.ts（OpenAI 线 + 线格式分派）/ adapter-degrade.test.ts
 *（400 降级 + A3 降级记忆）/ adapter-quirks.test.ts（quirks 参数面 + Grok 整块 +
 * reasoning 思维链 + tool_choice 表驱动）/ adapter-cache.test.ts（D4 cache token
 * 记账）/ adapter-responses.test.ts（Responses 线）；共享装置抽 adapter-fixtures.ts。
 * 本件保留 Anthropic 协议线残核（git 历史锚点），用例零改动。
 */
import { describe, expect, it } from 'vitest'
import Anthropic from '@anthropic-ai/sdk'
import { createAnthropicProvider } from '../../../src/ai/provider/anthropic-adapter.js'
import { CONF, REQ, collect, fakeSend } from './adapter-fixtures.js'

describe('Anthropic 适配器', () => {
  it('text_delta → text 事件 + message_delta usage → done', async () => {
    const client = {
      messages: {
        create: fakeSend([
          { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
          { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '你' } },
          { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '好' } },
          { type: 'content_block_stop', index: 0 },
          { type: 'message_delta', usage: { input_tokens: 5, output_tokens: 2 }, delta: { stop_reason: 'end_turn' } },
        ]),
      },
    } as unknown as Anthropic
    const evs = await collect(createAnthropicProvider(CONF, client), REQ)
    expect(evs.filter((e) => e.type === 'text')).toEqual([
      { type: 'text', delta: '你' },
      { type: 'text', delta: '好' },
    ])
    const done = evs.find((e) => e.type === 'done')
    expect(done).toMatchObject({ type: 'done', usage: { inputTokens: 5, outputTokens: 2 } })
  })

  it('input_json_delta 增量拼装 → tool 事件（审查 §五 契约核心）', async () => {
    const client = {
      messages: {
        create: fakeSend([
          { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', name: 'submit_chapter' } },
          { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"标题":' } },
          { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '"x","正文":"y"}' } },
          { type: 'content_block_stop', index: 0 },
          { type: 'message_delta', usage: { input_tokens: 1, output_tokens: 1 }, delta: { stop_reason: 'tool_use' } },
        ]),
      },
    } as unknown as Anthropic
    const evs = await collect(createAnthropicProvider(CONF, client), REQ)
    const tool = evs.find((e) => e.type === 'tool')
    expect(tool).toMatchObject({ type: 'tool', name: 'submit_chapter', input: { 标题: 'x', 正文: 'y' } })
  })

  // 重评-P3-1（2026-09-09 全量代码重评）：非标网关对同一 index 重发 content_block_stop
  // → stop 消费条目后只产出恰好一个 tool 事件（重复同 id tool_use 会写历史两条、回传 400）
  it('重复 content_block_stop（同 index 两次）→ 恰好一个 tool 事件', async () => {
    const client = {
      messages: {
        create: fakeSend([
          { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', name: 'submit_chapter' } },
          { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"标题":"x"}' } },
          { type: 'content_block_stop', index: 0 },
          { type: 'content_block_stop', index: 0 },
          { type: 'message_delta', usage: { input_tokens: 1, output_tokens: 1 }, delta: { stop_reason: 'tool_use' } },
        ]),
      },
    } as unknown as Anthropic
    const evs = await collect(createAnthropicProvider(CONF, client), REQ)
    const tools = evs.filter((e) => e.type === 'tool')
    expect(tools).toHaveLength(1)
    expect(tools[0]).toMatchObject({ type: 'tool', name: 'submit_chapter', input: { 标题: 'x' } })
  })

  // 低级项（第六轮）：兼容端点不发 tool_use id → 按 block index 生成兜底（空 id 进
  // 历史会被 tool_result 关联拒绝；对齐 OpenAI 线 P3-Q5 的 call_ 兜底）
  it('低级项：tool_use 缺 id → 兜底 toolu_<index>，不留空串', async () => {
    const client = {
      messages: {
        create: fakeSend([
          { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', name: 'submit_chapter' } },
          { type: 'content_block_stop', index: 0 },
          { type: 'message_delta', usage: { input_tokens: 1, output_tokens: 1 }, delta: { stop_reason: 'tool_use' } },
        ]),
      },
    } as unknown as Anthropic
    const evs = await collect(createAnthropicProvider(CONF, client), REQ)
    const tool = evs.find((e) => e.type === 'tool')
    expect(tool).toMatchObject({ type: 'tool', id: 'toolu_0', name: 'submit_chapter' })
  })

  it('tool JSON 损坏 → input 降级 { _raw }，不崩', async () => {
    const client = {
      messages: {
        create: fakeSend([
          { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', name: 'submit_text' } },
          { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{broken' } },
          { type: 'content_block_stop', index: 0 },
          { type: 'message_delta', usage: { input_tokens: 1, output_tokens: 1 }, delta: { stop_reason: 'tool_use' } },
        ]),
      },
    } as unknown as Anthropic
    const evs = await collect(createAnthropicProvider(CONF, client), REQ)
    const tool = evs.find((e) => e.type === 'tool')
    expect(tool).toMatchObject({ type: 'tool', input: { _raw: '{broken' } })
  })

  it('重复 message_delta → done 幂等（只发一次）', async () => {
    const client = {
      messages: {
        create: fakeSend([
          { type: 'message_delta', usage: { input_tokens: 1, output_tokens: 1 }, delta: { stop_reason: 'end_turn' } },
          { type: 'message_delta', usage: { input_tokens: 9, output_tokens: 9 }, delta: { stop_reason: 'end_turn' } },
        ]),
      },
    } as unknown as Anthropic
    const evs = await collect(createAnthropicProvider(CONF, client), REQ)
    expect(evs.filter((e) => e.type === 'done')).toHaveLength(1)
    // R27-2（二十七轮）：值口径改为「末见 wins」（与 openai 线 R26-3 归一）——末 delta
    // 9/9 胜出。R73-13b 锚定的「取首条」与此互斥，随本轮口径统一更新：done 次数幂等
    // （该测试的原始关切——重复 delta 不双发 done）保留不变；真·同值重传形态下末见
    // 与首见同值，去重场景不受影响
    expect(evs.find((e) => e.type === 'done')).toMatchObject({ usage: { inputTokens: 9, outputTokens: 9 } })
  })

  // R73-3（二十一轮 A-3）：Anthropic 协议强制 max_tokens——unknown 家族模型 quirks 无
  // maxOutputTokens，走协议兜底；8192 时写长章必截断且 MAX_TOKENS 终态不可重试，
  // 兜底提到 16384（对齐 quirks 表 claude 档）
  it('unknown 家族模型 max_tokens 协议兜底 16384（R73-3）', async () => {
    let captured: Record<string, unknown> | null = null
    const client = {
      messages: {
        create: (params: unknown) => {
          captured = params as Record<string, unknown>
          return fakeSend([
            { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
            { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '好' } },
            { type: 'content_block_stop', index: 0 },
            { type: 'message_delta', usage: { input_tokens: 1, output_tokens: 1 }, delta: { stop_reason: 'end_turn' } },
          ])()
        },
      },
    } as unknown as Anthropic
    // 'test-model' 不命中任何家族 → quirksFor 无 maxOutputTokens → 兜底链终值
    await collect(createAnthropicProvider(CONF, client), REQ)
    expect(captured).toMatchObject({ model: 'test-model', max_tokens: 16_384 })
  })

  it('req.maxTokens 显式指定时覆盖协议兜底（R73-3 对照）', async () => {
    let captured: Record<string, unknown> | null = null
    const client = {
      messages: {
        create: (params: unknown) => {
          captured = params as Record<string, unknown>
          return fakeSend([
            { type: 'message_delta', usage: { input_tokens: 1, output_tokens: 1 }, delta: { stop_reason: 'end_turn' } },
          ])()
        },
      },
    } as unknown as Anthropic
    await collect(createAnthropicProvider(CONF, client), { ...REQ, maxTokens: 4096 })
    expect(captured).toMatchObject({ max_tokens: 4096 })
  })

  // ── H-2（第六轮）：流结束兜底必须区分「有终止无 usage」与「传输截断」──

  it('H-2：无 message_delta（传输截断）→ error 可重试，不发 done、不伪造 end_turn', async () => {
    const client = {
      messages: {
        // 中转/代理提前断流的形态：yield 了半截文本后迭代器正常 return，无终止事件
        create: fakeSend([
          { type: 'message_start', message: { usage: { input_tokens: 7 } } },
          { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
          { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '半截' } },
        ]),
      },
    } as unknown as Anthropic
    const evs = await collect(createAnthropicProvider(CONF, client), REQ)
    expect(evs.some((e) => e.type === 'done')).toBe(false) // 修复前：伪造 done{7,0,'end_turn'}
    const err = evs.find((e) => e.type === 'error')
    expect(err).toMatchObject({ type: 'error', retryable: true, code: 'NETWORK' })
  })

  it('H-2：有 message_delta（stop_reason）无 usage → done 放行（input 用 message_start 缓存）', async () => {
    const client = {
      messages: {
        create: fakeSend([
          { type: 'message_start', message: { usage: { input_tokens: 7 } } },
          { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '回复' } },
          { type: 'message_delta', delta: { stop_reason: 'max_tokens' } },
        ]),
      },
    } as unknown as Anthropic
    const evs = await collect(createAnthropicProvider(CONF, client), REQ)
    const done = evs.find((e) => e.type === 'done')
    // R73-1：网关吞 usage → 估计入账。input 用 message_start 实测 7；output 按累计
    // 产出文本折算（'回复' 2 码位 × 0.6 → ceil = 2），不再恒 0；estimated 标记估计口径
    expect(done).toMatchObject({
      type: 'done',
      usage: { inputTokens: 7, outputTokens: 2, estimated: true },
      stopReason: 'max_tokens',
    })
    expect(evs.some((e) => e.type === 'error')).toBe(false)
  })

  it('APIError 429 → error 事件 retryable=true', async () => {
    const err = new Anthropic.APIError(429, { type: 'error', message: 'rate limited' }, 'rate limited', undefined)
    const client = {
      messages: { create: async () => Promise.reject(err) },
    } as unknown as Anthropic
    const evs = await collect(createAnthropicProvider(CONF, client), REQ)
    expect(evs[0]).toMatchObject({ type: 'error', retryable: true })
    const first = evs[0]
    if (first && first.type === 'error') expect(first.message).toContain('Anthropic API 429')
  })

  it('AbortError → error「已中断」', async () => {
    const abort = new Error('cancel') as Error & { name: 'AbortError' }
    abort.name = 'AbortError'
    const client = { messages: { create: () => Promise.reject(abort) } } as unknown as Anthropic
    const evs = await collect(createAnthropicProvider(CONF, client), REQ)
    expect(evs[0]).toMatchObject({ type: 'error', message: '已中断', retryable: false })
  })

  it('message_start 缓存 input_tokens（message_delta 不含时回退，P2-3）', async () => {
    const client = {
      messages: {
        create: fakeSend([
          { type: 'message_start', message: { usage: { input_tokens: 100, output_tokens: 1 } } },
          { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
          { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hi' } },
          { type: 'content_block_stop', index: 0 },
          { type: 'message_delta', usage: { output_tokens: 50 }, delta: { stop_reason: 'end_turn' } },
        ]),
      },
    } as unknown as Anthropic
    const evs = await collect(createAnthropicProvider(CONF, client), REQ)
    const done = evs.find((e) => e.type === 'done')
    // message_delta 无 input_tokens → 回退 message_start 缓存的 100
    expect(done).toMatchObject({ type: 'done', usage: { inputTokens: 100, outputTokens: 50 } })
  })
})
