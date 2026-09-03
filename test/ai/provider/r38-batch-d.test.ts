/**
 * R38-4~R38-8（三十八轮批 D）回归：AI 链路五件。
 *
 * - R38-4：listModels 的 OpenAI client 补 maxRetries: 0（静态锚定，对齐 anthropic
 *   分支的「SDK 内建重试破坏单层重试决策」纪律）。
 * - R38-5：兼容导出 createOpenAIProvider 透传 store/userDataPath（静态锚定签名面）。
 * - R38-6：canonicalize 剥 BOM——BOM overlay 命中内置历史哈希（此前永判「用户已改」）。
 * - R38-7：responses 线 tool 参数 done 项权威值优先（delta 丢片不再产出残缺 JSON）。
 * - R38-8：responses/anthropic 线 usage:{} 空对象走估计兜底（对齐 openai 线 isRealUsage
 *   R36-14 口径——R36-14 注释宣称三线一致，实测另两线漏配）。
 */
import { describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import Anthropic from '@anthropic-ai/sdk'
import OpenAI from 'openai'
import { createAnthropicProvider } from '../../../src/ai/provider/anthropic-adapter.js'
import { createOpenAIResponsesProvider } from '../../../src/ai/provider/responses-adapter.js'
import { migratePromptOverlays, overlayPath, promptHash, resolvePrompt, type PromptRegistry } from '../../../src/ai/prompts/resource.js'
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

const REQ: GenRequest = { systemPrompt: '', messages: [{ role: 'user', content: 'hi' }] }
const RCONF = { ...CONF, protocol: 'openai-responses' as const } as ProviderConf

describe('R38-8: responses/anthropic 线 usage:{} 空对象 → 估计兜底', () => {
  it('responses：completed usage:{} → done 估计入账（修复前 0/0 且无 estimated）', async () => {
    const client = {
      responses: {
        create: fakeSend([
          { type: 'response.output_text.delta', delta: '第一段正文内容。' },
          { type: 'response.completed', response: { output: [{ type: 'message' }], usage: {} } },
        ]),
      },
    } as unknown as OpenAI
    const evs = await collect(createOpenAIResponsesProvider(RCONF, client), {
      systemPrompt: '系统提示词',
      messages: [{ role: 'user', content: '写一段' }],
    })
    const done = evs.find((e) => e.type === 'done')
    if (done?.type !== 'done') return expect.fail('无 done 事件')
    // 修复前：{} truthy → toUsage({}) = 0/0 且无 estimated，预算闸对该网关永不生效
    expect(done.usage.estimated).toBe(true)
    expect(done.usage.inputTokens).toBeGreaterThan(0)
    expect(done.usage.outputTokens).toBeGreaterThan(0)
  })

  it('responses：部分计量字段在位（仅 output_tokens）→ 实测口径不标 estimated（presence 闸对齐 isRealUsage）', async () => {
    const client = {
      responses: {
        create: fakeSend([
          { type: 'response.completed', response: { output: [{ type: 'message' }], usage: { output_tokens: 4 } } },
        ]),
      },
    } as unknown as OpenAI
    const evs = await collect(createOpenAIResponsesProvider(RCONF, client), REQ)
    const done = evs.find((e) => e.type === 'done')
    expect(done).toMatchObject({ type: 'done', usage: { inputTokens: 0, outputTokens: 4 } })
    if (done?.type !== 'done') return
    expect(done.usage.estimated).toBeUndefined()
  })

  it('anthropic：message_delta usage:{} → 流末估计兜底（修复前 output 清 0 且无 estimated）', async () => {
    const client = {
      messages: {
        create: fakeSend([
          { type: 'message_start', message: { usage: { input_tokens: 7 } } },
          { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '回复' } },
          { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: {} },
        ]),
      },
    } as unknown as Anthropic
    const evs = await collect(createAnthropicProvider(CONF, client), REQ)
    const done = evs.find((e) => e.type === 'done')
    // 修复前：{} truthy 进 merge → latestUsage = {input:7, output:0} 假计量
    expect(done).toMatchObject({
      type: 'done',
      usage: { inputTokens: 7, outputTokens: 2, estimated: true },
      stopReason: 'end_turn',
    })
  })
})

describe('R38-7: responses 线 tool 参数 done 项权威值优先', () => {
  it('delta 丢片（残缺 JSON）+ done 项完整 arguments → 产出完整参数而非静默空对象', async () => {
    const client = {
      responses: {
        create: fakeSend([
          // 网关 delta 丢片：累计串为残缺 JSON
          { type: 'response.function_call_arguments.delta', delta: '{"chapter":1,"bo' },
          // done 项携带服务端权威完整串
          {
            type: 'response.output_item.done',
            item: { type: 'function_call', call_id: 'call_a', name: 'tool_a', arguments: '{"chapter":1,"body":"正文"}' },
          },
          { type: 'response.completed', response: { usage: { input_tokens: 5, output_tokens: 4 } } },
        ]),
      },
    } as unknown as OpenAI
    const evs = await collect(createOpenAIResponsesProvider(RCONF, client), {
      ...REQ,
      tools: [{ name: 'tool_a', description: 'd', input_schema: { type: 'object', properties: {} } }],
    })
    const tool = evs.find((e) => e.type === 'tool')
    // 修复前：acc.args 取累计残缺串 → JSON.parse 抛 → input = {_raw}（参数丢失）
    expect(tool).toMatchObject({ type: 'tool', name: 'tool_a', input: { chapter: 1, body: '正文' } })
  })
})

describe('R38-6: canonicalize 剥 BOM（BOM overlay 判定与消费两态修复）', () => {
  it('UTF-8-BOM overlay：resolvePrompt 文本剥 BOM；migrate 判「未改动」收口升级（修复前永判「用户已改」）', () => {
    const BUILTIN_V1 = '你是中文网文写作系统。'
    const BUILTIN_V2 = '你是中文网文写作系统（第二版）。'
    const registry: PromptRegistry = {
      readBuiltin: (n) => {
        if (n !== 'writer') throw new Error(`未知内置 prompt：${n}`)
        return BUILTIN_V2
      },
      // 版本表：V1（历史）→ V2（当前），时间序
      versions: () => ({ 'writer.md': [promptHash(BUILTIN_V1), promptHash(BUILTIN_V2)] }),
    }
    const ud = mkdtempSync(join(tmpdir(), 'r38-bom-'))
    try {
      // win 记事本保存形态：BOM 前缀 + 尾换行（内容 = 未改动的 V1 内置拷贝）
      mkdirSync(join(ud, 'prompts'), { recursive: true })
      writeFileSync(overlayPath(ud, 'writer'), `\uFEFF${BUILTIN_V1}\n`, 'utf-8')
      // 消费面：文本/BOM 剥净（修复前 \uFEFF 混进 system prompt 首字符）
      const r = resolvePrompt('writer', ud, registry)
      expect(r.source).toBe('overlay')
      expect(r.text).toBe(BUILTIN_V1)
      expect(r.hash).toBe(promptHash(BUILTIN_V1))
      // 迁移面：BOM overlay 哈希命中历史 → 判「未改动」升级为当前内置（修复前 kept）
      const report = migratePromptOverlays(ud, registry)
      expect(report.upgraded).toContain('writer')
      expect(readFileSync(overlayPath(ud, 'writer'), 'utf-8')).toBe(`${BUILTIN_V2}\n`)
    } finally {
      rmSync(ud, { recursive: true, force: true })
    }
  })
})

describe('R38-4/R38-5: 静态锚定（SDK 重试纪律与兼容导出透传）', () => {
  const modelsTs = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'src', 'ai', 'provider', 'models.ts'),
    'utf-8',
  )
  const adapterTs = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'src', 'ai', 'provider', 'openai-adapter.ts'),
    'utf-8',
  )

  it('R38-4: models.ts OpenAI client 构造带 maxRetries: 0（对齐 anthropic 分支）', () => {
    const openaiBranch = modelsTs.slice(modelsTs.indexOf('new OpenAI('))
    expect(openaiBranch.slice(0, 80)).toContain('maxRetries: 0')
  })

  it('R38-5: createOpenAIProvider 兼容导出透传 store/userDataPath', () => {
    const sig = adapterTs.slice(adapterTs.indexOf('export function createOpenAIProvider('), adapterTs.indexOf('export function createOpenAIProvider(') + 400)
    expect(sig).toContain('store?: ProviderStore')
    expect(sig).toContain('userDataPath?: string')
    expect(sig).toContain('createOpenAIProviderChat(conf, client, store, userDataPath)')
  })
})
