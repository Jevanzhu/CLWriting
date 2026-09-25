/**
 * R0916-7-P3-15（2026-09-24 全项目源码质量与优雅度评审 P3-15）回归：流尾收口收敛后行为不变。
 *
 * 过滤 / 拒答、传输截断、无 usage 的估计兜底三类收尾原在 openai（content_filter 两份 +
 * 估计三份）、anthropic（refusal 两份 + 估计两份）、responses（估计 / 截断各一）三线
 * 各写各的；收敛到 provider/stream-finalize.ts 后本用例以「一处表 + 三线共跑」锁住
 * 事件形状与取值口径逐位不变（含 usage 随错上抛与 estimated 标记）。
 */
import { describe, expect, it } from 'vitest'
import Anthropic from '@anthropic-ai/sdk'
import OpenAI from 'openai'
import { createAnthropicProvider } from '../../../src/ai/provider/anthropic-adapter.js'
import { createOpenAIProviderChat } from '../../../src/ai/provider/openai-adapter.js'
import { createOpenAIResponsesProvider } from '../../../src/ai/provider/responses-adapter.js'
import { CONF, collect, fakeSend } from './adapter-fixtures.js'
import type { GenEvent, GenRequest, ModelProvider, ProviderConf } from '../../../src/ai/provider/index.js'

type Kind = 'openai' | 'anthropic' | 'responses'

const LONG_REQ: GenRequest = {
  systemPrompt: '',
  messages: [{ role: 'user', content: '请写一段足够长的正文内容，用于产出折算非零。'.repeat(10) }],
}

function makeProvider(kind: Kind, events: unknown[]): ModelProvider {
  if (kind === 'openai') {
    const client = { chat: { completions: { create: fakeSend(events) } } } as unknown as OpenAI
    return createOpenAIProviderChat(CONF, client)
  }
  if (kind === 'anthropic') {
    const client = { messages: { create: fakeSend(events) } } as unknown as Anthropic
    return createAnthropicProvider(CONF, client)
  }
  const client = { responses: { create: fakeSend(events) } } as unknown as OpenAI
  return createOpenAIResponsesProvider({ ...CONF, protocol: 'openai-responses', model: 'gpt-5' } as ProviderConf, client)
}

function firstError(evs: GenEvent[]): Extract<GenEvent, { type: 'error' }> {
  const err = evs.find((e) => e.type === 'error') as Extract<GenEvent, { type: 'error' }> | undefined
  expect(err).toBeDefined()
  return err!
}

function firstDone(evs: GenEvent[]): Extract<GenEvent, { type: 'done' }> | undefined {
  return evs.find((e) => e.type === 'done') as Extract<GenEvent, { type: 'done' }> | undefined
}

// ── ① 过滤 / 拒答：error 出场（不发 done），usage 随错上抛 ──────────────

const FILTER_CASES: Array<{
  kind: Kind
  label: string
  events: unknown[]
  usage: { inputTokens: number; outputTokens: number }
  evidence: string
}> = [
  {
    kind: 'openai',
    label: 'finish_reason=content_filter',
    events: [
      { choices: [{ delta: { content: '半截' }, finish_reason: null }] },
      { choices: [{ delta: {}, finish_reason: 'content_filter' }], usage: { prompt_tokens: 8, completion_tokens: 2 } },
    ],
    usage: { inputTokens: 8, outputTokens: 2 },
    evidence: 'finish_reason=content_filter',
  },
  {
    kind: 'anthropic',
    label: 'stop_reason=refusal',
    events: [
      { type: 'message_start', message: { usage: { input_tokens: 11 } } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '半截' } },
      { type: 'message_delta', delta: { stop_reason: 'refusal' }, usage: { output_tokens: 3 } },
    ],
    usage: { inputTokens: 11, outputTokens: 3 },
    evidence: 'stop_reason=refusal',
  },
]

describe('P3-15：过滤 / 拒答（实测 usage 在手 → 原值上抛，不发 done）', () => {
  for (const c of FILTER_CASES) {
    it(`${c.kind}：${c.label}`, async () => {
      const evs = await collect(makeProvider(c.kind, c.events), LONG_REQ)
      expect(firstDone(evs)).toBeUndefined()
      const err = firstError(evs)
      expect(err).toMatchObject({ type: 'error', retryable: false, code: 'PROTOCOL' })
      // 文案证据出处逐字保留（field=value）
      expect(err.message).toContain(c.evidence)
      expect(err.message).toContain('半截产出不落稿')
      expect(err.usage).toMatchObject(c.usage)
      expect(err.usage?.estimated).toBeUndefined() // 实测值不带估计标记
    })
  }
})

// ── ② 过滤 / 拒答且网关不回 usage：估计兜底（estimated 标记） ──────────

const FILTER_NO_USAGE_CASES: Array<{ kind: Kind; label: string; events: unknown[]; evidence: string }> = [
  {
    kind: 'openai',
    label: 'content_filter 无 usage',
    events: [
      { choices: [{ delta: { content: '半截' }, finish_reason: null }] },
      { choices: [{ delta: {}, finish_reason: 'content_filter' }] },
    ],
    evidence: 'finish_reason=content_filter',
  },
  {
    kind: 'anthropic',
    label: 'refusal 无 usage',
    events: [
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '半截' } },
      { type: 'message_delta', delta: { stop_reason: 'refusal' } },
    ],
    evidence: 'stop_reason=refusal',
  },
]

describe('P3-15：过滤 / 拒答（无 usage → 估计入账，estimated 标记）', () => {
  for (const c of FILTER_NO_USAGE_CASES) {
    it(`${c.kind}：${c.label}`, async () => {
      const evs = await collect(makeProvider(c.kind, c.events), LONG_REQ)
      expect(firstDone(evs)).toBeUndefined()
      const err = firstError(evs)
      expect(err).toMatchObject({ type: 'error', retryable: false, code: 'PROTOCOL' })
      expect(err.message).toContain(c.evidence)
      expect(err.usage?.estimated).toBe(true)
      expect(err.usage?.inputTokens).toBeGreaterThan(0)
      expect(err.usage?.outputTokens).toBeGreaterThan(0)
    })
  }
})

// ── ③ 无 usage 的正常完成：估计兜底 done（三线同口径） ─────────────────

const NO_USAGE_DONE_CASES: Array<{ kind: Kind; label: string; events: unknown[]; stopReason: string }> = [
  {
    kind: 'openai',
    label: '有 finish_reason 无 usage',
    events: [{ choices: [{ delta: { content: '完整正文。' }, finish_reason: 'stop' }] }],
    stopReason: 'stop',
  },
  {
    kind: 'anthropic',
    label: '有 message_delta(stop_reason) 无 usage',
    events: [
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '完整正文。' } },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
    ],
    stopReason: 'end_turn',
  },
  {
    kind: 'responses',
    label: 'completed 无 usage',
    events: [
      { type: 'response.output_text.delta', delta: '完整正文。' },
      { type: 'response.completed', response: { output: [{ type: 'message' }] } },
    ],
    stopReason: 'stop',
  },
]

describe('P3-15：无 usage 的正常完成 → 估计入账 done（三线同口径）', () => {
  for (const c of NO_USAGE_DONE_CASES) {
    it(`${c.kind}：${c.label}`, async () => {
      const evs = await collect(makeProvider(c.kind, c.events), LONG_REQ)
      expect(evs.some((e) => e.type === 'error')).toBe(false)
      const done = firstDone(evs)
      expect(done).toBeDefined()
      expect(done!.stopReason).toBe(c.stopReason)
      expect(done!.usage.estimated).toBe(true)
      expect(done!.usage.inputTokens).toBeGreaterThan(0)
      expect(done!.usage.outputTokens).toBeGreaterThan(0)
    })
  }
})

// ── ④ 无终止事件：传输截断（可重试 error，不发 done） ──────────────────

const TRUNCATION_CASES: Array<{ kind: Kind; label: string; events: unknown[] }> = [
  {
    kind: 'openai',
    label: '无 finish_reason 断流',
    events: [{ choices: [{ delta: { content: '半截' }, finish_reason: null }] }],
  },
  {
    kind: 'anthropic',
    label: '无 message_delta 断流',
    events: [
      { type: 'message_start', message: { usage: { input_tokens: 5 } } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '半截' } },
    ],
  },
  {
    kind: 'responses',
    label: '无终止事件断流',
    events: [{ type: 'response.output_text.delta', delta: '半截' }],
  },
]

describe('P3-15：无终止事件 → 传输截断（可重试；估计 usage 随错上抛）', () => {
  for (const c of TRUNCATION_CASES) {
    it(`${c.kind}：${c.label}`, async () => {
      const evs = await collect(makeProvider(c.kind, c.events), LONG_REQ)
      expect(firstDone(evs)).toBeUndefined()
      const err = firstError(evs)
      expect(err).toMatchObject({ type: 'error', retryable: true, code: 'NETWORK' })
      expect(err.message).toBe('传输截断：流结束无终止事件')
      expect(err.usage?.inputTokens).toBeGreaterThan(0)
      expect(err.usage?.outputTokens).toBeGreaterThan(0)
    })
  }
})
