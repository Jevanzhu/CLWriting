/**
 * R0916-7-P3-15（2026-09-24 全项目源码质量与优雅度评审 P3-15）回归：stopReason 归一判别表。
 *
 * 覆盖两面：
 * ① 归一函数 normalizeStopReason 的逐线值表（别名归一 / 原生值直通 / 未知值归 'unknown'
 *    且留痕）；
 * ② 三适配器实际产出的 done.stopReason 逐线验证——线上终止值经各适配器的捕获点进入
 *    判别联合，含非标网关自造拼写的未知值路径（归 'unknown'，不再以任意字符串出场）。
 */
import { describe, expect, it, vi, afterEach, type MockInstance } from 'vitest'
import Anthropic from '@anthropic-ai/sdk'
import OpenAI from 'openai'
import { createAnthropicProvider } from '../../../src/ai/provider/anthropic-adapter.js'
import { createOpenAIProviderChat } from '../../../src/ai/provider/openai-adapter.js'
import { createOpenAIResponsesProvider } from '../../../src/ai/provider/responses-adapter.js'
import { isStopReason, normalizeStopReason } from '../../../src/ai/provider/stream-finalize.js'
import { log } from '../../../src/log/index.js'
import { CONF, REQ, collect, fakeSend } from './adapter-fixtures.js'
import type { GenEvent, ModelProvider, ProviderConf, StopReason } from '../../../src/ai/provider/index.js'

/** 未知值留痕断言用：取本用例关注的结构化日志（过滤环境噪声） */
function providerWarns(spy: MockInstance<typeof log.warn>, msg: string): Array<Record<string, unknown>> {
  return spy.mock.calls
    .map((c) => (c[0] === 'provider' ? String(c[1]) : ''))
    .filter((m) => m.includes(msg))
    .map((m) => JSON.parse(m) as Record<string, unknown>)
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('normalizeStopReason：三线值表', () => {
  const TABLE: Array<{ line: 'openai' | 'anthropic' | 'responses'; raw: string; expected: StopReason }> = [
    // openai：两个协议别名 + 原生直通 + 旧函数调用遗留值
    { line: 'openai', raw: 'length', expected: 'max_tokens' },
    { line: 'openai', raw: 'tool_calls', expected: 'tool_use' },
    { line: 'openai', raw: 'stop', expected: 'stop' },
    { line: 'openai', raw: 'content_filter', expected: 'content_filter' },
    { line: 'openai', raw: 'function_call', expected: 'function_call' },
    // anthropic：原生七值直通
    { line: 'anthropic', raw: 'end_turn', expected: 'end_turn' },
    { line: 'anthropic', raw: 'max_tokens', expected: 'max_tokens' },
    { line: 'anthropic', raw: 'tool_use', expected: 'tool_use' },
    { line: 'anthropic', raw: 'stop_sequence', expected: 'stop_sequence' },
    { line: 'anthropic', raw: 'pause_turn', expected: 'pause_turn' },
    { line: 'anthropic', raw: 'refusal', expected: 'refusal' },
    { line: 'anthropic', raw: 'model_context_window_exceeded', expected: 'model_context_window_exceeded' },
    // responses：本线不读线上拼写（产出自终止事件类型判定），值恒在联合内
    { line: 'responses', raw: 'stop', expected: 'stop' },
    { line: 'responses', raw: 'tool_use', expected: 'tool_use' },
    { line: 'responses', raw: 'max_tokens', expected: 'max_tokens' },
  ]

  for (const c of TABLE) {
    it(`${c.line}：'${c.raw}' → '${c.expected}'（无留痕）`, () => {
      const spy = vi.spyOn(log, 'warn')
      expect(normalizeStopReason(c.raw, c.line)).toBe(c.expected)
      expect(providerWarns(spy, 'stopReason 未知值')).toHaveLength(0)
    })
  }

  for (const line of ['openai', 'anthropic', 'responses'] as const) {
    it(`${line}：非标拼写 → 'unknown' 且留痕（line/raw 字段可归因）`, () => {
      const spy = vi.spyOn(log, 'warn')
      expect(normalizeStopReason('eos-not-a-real-reason', line)).toBe('unknown')
      const warns = providerWarns(spy, 'stopReason 未知值')
      expect(warns).toHaveLength(1)
      expect(warns[0]).toMatchObject({ line, raw: 'eos-not-a-real-reason' })
    })
  }

  it("归一产出恒为联合成员（'unknown' 自身不再触发留痕）", () => {
    const spy = vi.spyOn(log, 'warn')
    expect(normalizeStopReason('unknown', 'openai')).toBe('unknown')
    expect(providerWarns(spy, 'stopReason 未知值')).toHaveLength(0)
    expect(isStopReason('unknown')).toBe(true)
  })
})

// ── 适配器级：线上终止值 → done.stopReason ─────────────────────────────

const MANY = '请写一段足够长的正文内容，用于产出折算非零。'.repeat(10)
const LONG_REQ = { systemPrompt: '', messages: [{ role: 'user' as const, content: MANY }] }

/** openai Chat 线：内容 delta + finish_reason + 实测 usage 一 chunk 收尾 */
function openaiEvents(finishReason: string): unknown[] {
  return [
    {
      choices: [{ delta: { content: '正文' }, finish_reason: finishReason }],
      usage: { prompt_tokens: 3, completion_tokens: 2 },
    },
  ]
}

/** anthropic 线：message_start + text delta + message_delta（含 stop_reason 与 usage） */
function anthropicEvents(stopReason: string | null): unknown[] {
  return [
    { type: 'message_start', message: { usage: { input_tokens: 5 } } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '正文' } },
    {
      type: 'message_delta',
      delta: stopReason === null ? {} : { stop_reason: stopReason },
      usage: { output_tokens: 2 },
    },
  ]
}

/** responses 线：completed（终态事件类型定值）+ output message 项 */
function responsesCompletedItems(withTool: boolean): unknown[] {
  return [
    { type: 'response.output_text.delta', delta: '正文' },
    {
      type: 'response.completed',
      response: {
        output: withTool
          ? [{ type: 'function_call', call_id: 'call_1', name: 'toolA', arguments: '{}' }]
          : [{ type: 'message' }],
        usage: { input_tokens: 4, output_tokens: 3 },
      },
    },
  ]
}

function makeProvider(kind: 'openai' | 'anthropic' | 'responses', events: unknown[]): ModelProvider {
  if (kind === 'openai') {
    const client = { chat: { completions: { create: fakeSend(events) } } } as unknown as OpenAI
    return createOpenAIProviderChat(CONF, client)
  }
  if (kind === 'anthropic') {
    const client = { messages: { create: fakeSend(events) } } as unknown as Anthropic
    return createAnthropicProvider(CONF, client)
  }
  const client = { responses: { create: fakeSend(events) } } as unknown as OpenAI
  return createOpenAIResponsesProvider(
    { ...CONF, protocol: 'openai-responses', model: 'gpt-5' } as ProviderConf,
    client,
  )
}

/** 取 done 事件的 stopReason（缺 done 即用例失败） */
function doneStopReason(evs: GenEvent[]): string {
  const done = evs.find((e) => e.type === 'done')
  expect(done).toBeDefined()
  return (done as Extract<GenEvent, { type: 'done' }>).stopReason
}

describe('三线 done.stopReason 逐线判别（含未知值路径）', () => {
  const CASES: Array<{
    kind: 'openai' | 'anthropic' | 'responses'
    label: string
    events: unknown[]
    expected: StopReason
    trail: boolean
  }> = [
    { kind: 'openai', label: "finish_reason='stop'", events: openaiEvents('stop'), expected: 'stop', trail: false },
    {
      kind: 'openai',
      label: "finish_reason='length' → max_tokens",
      events: openaiEvents('length'),
      expected: 'max_tokens',
      trail: false,
    },
    {
      kind: 'openai',
      label: "finish_reason='tool_calls' → tool_use",
      events: openaiEvents('tool_calls'),
      expected: 'tool_use',
      trail: false,
    },
    {
      kind: 'openai',
      label: "finish_reason='function_call'（遗留值保留）",
      events: openaiEvents('function_call'),
      expected: 'function_call',
      trail: false,
    },
    {
      kind: 'openai',
      label: '非标 finish_reason → unknown',
      events: openaiEvents('eos'),
      expected: 'unknown',
      trail: true,
    },
    {
      kind: 'anthropic',
      label: "stop_reason='end_turn'",
      events: anthropicEvents('end_turn'),
      expected: 'end_turn',
      trail: false,
    },
    {
      kind: 'anthropic',
      label: "stop_reason='max_tokens'",
      events: anthropicEvents('max_tokens'),
      expected: 'max_tokens',
      trail: false,
    },
    {
      kind: 'anthropic',
      label: "stop_reason='tool_use'",
      events: anthropicEvents('tool_use'),
      expected: 'tool_use',
      trail: false,
    },
    {
      kind: 'anthropic',
      label: "stop_reason='stop_sequence'",
      events: anthropicEvents('stop_sequence'),
      expected: 'stop_sequence',
      trail: false,
    },
    {
      kind: 'anthropic',
      label: "stop_reason='pause_turn'",
      events: anthropicEvents('pause_turn'),
      expected: 'pause_turn',
      trail: false,
    },
    {
      kind: 'anthropic',
      label: '非标 stop_reason → unknown',
      events: anthropicEvents('mystery_stop'),
      expected: 'unknown',
      trail: true,
    },
    // 本线协议口径：usage 已到但不带 stop_reason = 回合正常结束（显式 missingStopReason，非静默兜底）
    {
      kind: 'anthropic',
      label: 'usage 到但无 stop_reason → end_turn（协议默认，无留痕）',
      events: anthropicEvents(null),
      expected: 'end_turn',
      trail: false,
    },
    {
      kind: 'responses',
      label: 'completed + message 项 → stop',
      events: responsesCompletedItems(false),
      expected: 'stop',
      trail: false,
    },
    {
      kind: 'responses',
      label: 'completed + function_call 项 → tool_use',
      events: responsesCompletedItems(true),
      expected: 'tool_use',
      trail: false,
    },
    {
      kind: 'responses',
      label: 'incomplete(max_output_tokens) → max_tokens',
      events: [
        { type: 'response.output_text.delta', delta: '半截正文' },
        {
          type: 'response.incomplete',
          response: {
            incomplete_details: { reason: 'max_output_tokens' },
            usage: { input_tokens: 4, output_tokens: 3 },
          },
        },
      ],
      expected: 'max_tokens',
      trail: false,
    },
  ]

  for (const c of CASES) {
    it(`${c.kind}：${c.label}`, async () => {
      const spy = vi.spyOn(log, 'warn')
      const evs = await collect(makeProvider(c.kind, c.events), c.kind === 'anthropic' ? LONG_REQ : REQ)
      expect(doneStopReason(evs)).toBe(c.expected)
      expect(providerWarns(spy, 'stopReason 未知值')).toHaveLength(c.trail ? 1 : 0)
      expect(isStopReason(c.expected)).toBe(true)
    })
  }
})
