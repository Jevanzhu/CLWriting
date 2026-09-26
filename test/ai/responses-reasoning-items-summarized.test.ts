/**
 * A-5（二十九轮）：Responses 线单回合多条加密推理项——覆盖式收集只留末条（gen.ts
 * GenResult.reasoningEncrypted 单槽）时，适配器流尾一次性汇总 warn 留痕丢弃条数
 * （修复前无感消失；逐条 warn 会刷屏，取汇总口径）。
 * 假 client 按脚本吐流（同 responses-encrypted.test.ts 口径）。
 */
import { describe, expect, it, vi } from 'vitest'
import type OpenAI from 'openai'
import { createOpenAIResponsesProvider } from '../../src/ai/provider/index.js'
import type { GenEvent, GenRequest, ProviderConf } from '../../src/ai/provider/index.js'

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

function scriptedResponses(events: unknown[]): OpenAI {
  return {
    responses: {
      create: async function* (params: Record<string, unknown>): AsyncGenerator<unknown> {
        void params
        for (const ev of events) yield ev
      },
    },
  } as unknown as OpenAI
}

async function run(events: unknown[]): Promise<GenEvent[]> {
  const prov = createOpenAIResponsesProvider(RCONF, scriptedResponses(events))
  const out: GenEvent[] = []
  for await (const ev of prov.stream({ systemPrompt: '', messages: [{ role: 'user', content: '你好' }] } as GenRequest, new AbortController().signal)) out.push(ev)
  return out
}

function reasoningDone(id: string): unknown {
  return { type: 'response.output_item.done', item: { type: 'reasoning', id, encrypted_content: `ENC-${id}` } }
}

describe('A-5：多条加密推理项丢弃汇总留痕', () => {
  it('单回合 3 条加密推理项 → 3 个 reasoning_item 照常透出，流尾恰 1 条汇总 warn（丢弃 2 条）', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const events = await run([reasoningDone('rs_1'), reasoningDone('rs_2'), reasoningDone('rs_3'), COMPLETED])
      const items = events.filter((e) => e.type === 'reasoning_item')
      expect(items).toHaveLength(3) // 透出契约不变（收集/覆盖在 gen.ts）
      const summary = warn.mock.calls.filter((c) => String(c[0]).includes('加密推理项'))
      expect(summary).toHaveLength(1) // 一次性汇总，不刷屏
      expect(String(summary[0]![0])).toContain('3 条')
      expect(String(summary[0]![0])).toContain('丢弃 2 条')
    } finally {
      warn.mockRestore()
    }
  })

  it('单条（常态）→ 不产生汇总 warn', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const events = await run([reasoningDone('rs_only'), COMPLETED])
      expect(events.filter((e) => e.type === 'reasoning_item')).toHaveLength(1)
      expect(warn.mock.calls.filter((c) => String(c[0]).includes('加密推理项'))).toHaveLength(0)
    } finally {
      warn.mockRestore()
    }
  })
})
