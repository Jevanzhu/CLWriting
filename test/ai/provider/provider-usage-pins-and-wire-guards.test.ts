/**
 * R38-4~R38-8（三十八轮批 D）回归：AI 链路五件。
 *
 * - R38-4：listModels 的 OpenAI client 补 maxRetries: 0（对齐 anthropic 分支的「SDK
 *   内建重试破坏单层重试决策」纪律）。
 * - R38-5：openai 线工厂透传 store/userDataPath。原锚定薄壳兼容导出 createOpenAIProvider，
 *   R0916-7-P3-11 已删该纯别名（两入口同名同义，调用方看不出该用哪个）；本项改锚唯一
 *   工厂 createOpenAIProviderChat——漏传两形参会让降级记忆持久化（400 学习写回
 *   providers.json）静默失效。
 * - R38-6：canonicalize 剥 BOM——BOM overlay 命中内置历史哈希（此前永判「用户已改」）。
 * - R38-7：responses 线 tool 参数 done 项权威值优先（delta 丢片不再产出残缺 JSON）。
 * - R38-8：responses/anthropic 线 usage:{} 空对象走估计兜底（对齐 openai 线 isRealUsage
 *   R36-14 口径——R36-14 注释宣称三线一致，实测另两线漏配）。
 *
 * P3-5 源码文本锚行为化：R38-4/R38-5 原为 readFileSync 源码切片断言（`maxRetries: 0`
 * 字面量 / 工厂签名形参名），改边界行为直测——vi.mock('openai') 捕获 client 构造参数、
 * structured 400 降级记忆按显式 path 落盘端到端（行为逐位等价，重构耐受）。
 */
import { describe, expect, it, vi } from 'vitest'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdtempTracked } from '../../helpers/temp-dir.js'
import Anthropic from '@anthropic-ai/sdk'
import OpenAI from 'openai'
import { createAnthropicProvider } from '../../../src/ai/provider/anthropic-adapter.js'
import { createOpenAIResponsesProvider } from '../../../src/ai/provider/responses-adapter.js'
import { createOpenAIProviderChat } from '../../../src/ai/provider/openai-adapter.js'
import { listModels, normalizeBaseUrl } from '../../../src/ai/provider/models.js'
import { resolveProvider } from '../../../src/ai/runner.js'
import { saveProviders } from '../../../src/ai/provider/store.js'
import { migratePromptOverlays, overlayPath, promptHash, resolvePrompt, type PromptRegistry } from '../../../src/ai/prompts/resource.js'
import type { GenEvent, GenRequest, ModelProvider, ProviderConf } from '../../../src/ai/provider/index.js'

// vi.mock('openai')：默认导出换捕获构造参数的桩类（models.list 乱序两行 → 排序出口），
// 命名导出（APIError 等）保持真身——R38-4 构造参数行为锚 + 本文件其余用例的
// `new OpenAI.APIError(400, …)` 直抛桩不受影响（适配器只消费传入 client，不自行构造）。
const OPENAI_CTOR = vi.hoisted(() => ({ calls: [] as Array<Record<string, unknown>> }))
vi.mock('openai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('openai')>()
  class FakeOpenAI {
    static APIError = actual.APIError
    models = {
      list: async () => ({ data: [{ id: 'b' }, { id: 'a' }] }),
    }
    constructor(opts: Record<string, unknown>) {
      OPENAI_CTOR.calls.push(opts)
    }
  }
  return { ...actual, default: FakeOpenAI }
})

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

/** 最小 providers.json（openai 协议 + gpt 模型行）——R38-5 降级持久化通道注册前置 */
function writeUdProvidersOpenAI(ud: string): void {
  saveProviders(ud, {
    providers: [
      {
        id: 'prov-a',
        name: 'A',
        protocol: 'openai',
        auth: 'bearer',
        baseUrl: 'https://a.local',
        model: 'gpt-5',
        apiKey: 'sk-ud-secret',
        caps: { connected: true, streaming: true },
      },
    ],
    currentId: 'prov-a',
    currentModel: 'gpt-5',
    modelCaps: {},
    ragProviders: [],
    tiers: { creative: { model: 'gpt-5', effort: 'medium' }, assistant: null, chat: null },
    revision: 0,
    vault: null,
    dek: null,
  })
}

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
    const ud = mkdtempTracked(join(tmpdir(), 'r38-bom-'))
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

// ── R38-4 / R38-5：SDK 重试纪律与工厂透传（P3-5 源码文本锚行为化：原版 readFileSync
//    models.ts/openai-adapter.ts 源码断言 `maxRetries: 0` / 形参签名，对无害重构敏感、
//    对语义破坏不敏感——改为边界行为直测：构造参数捕获 + 降级记忆按显式 path 落盘）──

describe('R38-4: listModels 的 OpenAI client 关闭 SDK 内建重试', () => {
  it('构造 client 带 maxRetries: 0（SDK 内建重试破坏单层重试决策、退避消耗 abort 窗），404 回退空列表', async () => {
    const baseUrl = 'https://api.test.com/v1'
    const ids = await listModels('openai', baseUrl, 'sk-test-key')
    // 桩 client models.list 返回乱序两行 → 排序出口顺带锚定
    expect(ids).toEqual(['a', 'b'])
    // 构造参数行为锚：maxRetries: 0 对齐 anthropic 分支（anthropicClientOpts 同款纪律）
    expect(OPENAI_CTOR.calls).toHaveLength(1)
    expect(OPENAI_CTOR.calls[0]).toMatchObject({
      apiKey: 'sk-test-key',
      baseURL: normalizeBaseUrl(baseUrl, 'openai'),
      maxRetries: 0,
    })
  })
})

describe('R38-5: createOpenAIProviderChat 透传 store/userDataPath（降级记忆按显式 path 落盘）', () => {
  it('structured 400 → 剥除重试成功；降级记忆写回显式 userDataPath 的 providers.json（漏传两形参即静默失效）', async () => {
    const ud = mkdtempTracked(join(tmpdir(), 'r38-openai-degrade-'))
    try {
      // 注册降级持久化通道（resolveProvider 经 createProvider 注入的同参形态，r30 R30-4 先例）
      writeUdProvidersOpenAI(ud)
      expect(resolveProvider(ud).ok).toBe(true)

      let calls = 0
      const client = {
        chat: {
          completions: {
            create: async (params: Record<string, unknown>) => {
              calls++
              if ((params['response_format'] as Record<string, unknown> | undefined)?.['type'] === 'json_schema') {
                throw new OpenAI.APIError(400, { type: 'error', message: 'bad request' }, 'bad request', undefined)
              }
              return (async function* () {
                yield { choices: [{ delta: { content: '正文产出' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } }
              })()
            },
          },
        },
      } as unknown as OpenAI
      // gpt 系列 json_schema 档 → structured 请求有降级链可续跑
      const prov = createOpenAIProviderChat({ ...CONF, model: 'gpt-5' }, client, undefined, ud)
      const evs = await collect(prov, { ...REQ, structured: { schema: { type: 'object' } } })
      expect(evs.some((e) => e.type === 'done')).toBe(true) // 400 → 剥 structured 重试成功
      expect(calls).toBe(2) // 首发 json_schema 400 + 降级剥除重试
      // 修复点：userDataPath 透传 → 降级记忆写回该库 providers.json
      const caps = (JSON.parse(readFileSync(join(ud, 'providers.json'), 'utf8')) as { modelCaps?: Record<string, unknown> }).modelCaps
      expect(caps?.['t1/gpt-5']).toEqual({ structured: false })
    } finally {
      rmSync(ud, { recursive: true, force: true })
    }
  })
})
