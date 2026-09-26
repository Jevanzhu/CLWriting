/**
 * 适配器 400 降级与降级记忆单测（R0916-5b 拆分件，2026-09-16）。
 *
 * 拆分来源：test/ai/provider/adapter.test.ts（原「双协议适配器单测」，原头注沿革
 * 见残核 adapter.test.ts）——本件承接降级域：「Anthropic 适配器 400 降级（§6.5：仅
 * structured 一级 + 记忆）」与「A3（五十九轮）：记忆命中首发剥除成功 → done 带
 * degraded」两 describe 整块搬移零改动；公共错误处理钉板另见 adapter-errors.test.ts。
 */
import { describe, expect, it } from 'vitest'
import Anthropic from '@anthropic-ai/sdk'
import { createAnthropicProvider } from '../../../src/ai/provider/anthropic-adapter.js'
import type { ProviderConf } from '../../../src/ai/provider/index.js'
import type { ProviderStore } from '../../../src/ai/provider/store.js'
import { CONF, REQ, collect } from './adapter-fixtures.js'

describe('Anthropic 适配器 400 降级（§6.5：仅 structured 一级 + 记忆）', () => {
  it('output_config.format 400 → 剥 structured 重试成功', async () => {
    let callCount = 0
    const client = {
      messages: {
        create: async (params: unknown) => {
          callCount++
          // 第一次含 output_config.format → 模拟 400
          const p = params as Record<string, unknown>
          if (p['output_config'] && (p['output_config'] as Record<string, unknown>)['format']) {
            throw new Anthropic.APIError(400, { type: 'error', message: 'bad request' }, 'bad request', undefined)
          }
          // 第二次不含 → 正常返回
          return (async function* () {
            yield { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }
            yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } }
            yield { type: 'content_block_stop', index: 0 }
            yield {
              type: 'message_delta',
              usage: { input_tokens: 1, output_tokens: 1 },
              delta: { stop_reason: 'end_turn' },
            }
          })()
        },
      },
    } as unknown as Anthropic
    // claude 系列 structuredMode=json_schema → 发 format → 400 → 剥 structured 重试
    const evs = await collect(createAnthropicProvider({ ...CONF, model: 'claude-sonnet-5' } as ProviderConf, client), {
      ...REQ,
      structured: { schema: { type: 'object', properties: {} } },
    })
    expect(callCount).toBe(2) // 第一次 400 → 第二次降级成功
    expect(evs.some((e) => e.type === 'text')).toBe(true)
    expect(evs.some((e) => e.type === 'done')).toBe(true)
  })

  it('降级命中 → 写记忆（structured 不支持），下次直接跳过 structured 单次请求', async () => {
    let callCount = 0
    const client = {
      messages: {
        create: async (params: unknown) => {
          callCount++
          const p = params as Record<string, unknown>
          if (p['output_config'] && (p['output_config'] as Record<string, unknown>)['format']) {
            throw new Anthropic.APIError(400, { type: 'error', message: 'bad request' }, 'bad request', undefined)
          }
          return (async function* () {
            yield {
              type: 'message_delta',
              usage: { input_tokens: 1, output_tokens: 1 },
              delta: { stop_reason: 'end_turn' },
            }
          })()
        },
      },
    } as unknown as Anthropic
    const store: ProviderStore = {
      providers: [],
      currentId: null,
      currentModel: null,
      modelCaps: {},
      ragProviders: [],
      tiers: { creative: { model: '', effort: 'high' }, assistant: null, chat: null },
      revision: 0,
      vault: null,
      dek: null,
    }
    const prov = createAnthropicProvider({ ...CONF, model: 'claude-sonnet-5' } as ProviderConf, client, store)
    // 第一次：带 structured → 400 → 降级重试 → 建流成功才写记忆
    await collect(prov, { ...REQ, structured: { schema: {} } })
    expect(store.modelCaps['t1/claude-sonnet-5']).toEqual({ structured: false })
    // 第二次：记忆命中 → 首发即剥 structured，一次请求即成功（不再 400 重试）
    callCount = 0
    const evs2 = await collect(prov, { ...REQ, structured: { schema: {} } })
    expect(callCount).toBe(1)
    // 不止 callCount=1——必须真的成功产出（记忆不得关闭降级链导致必败）
    expect(evs2.some((e) => e.type === 'done')).toBe(true)
    expect(evs2.some((e) => e.type === 'error')).toBe(false)
  })

  it('effort 400 不再降级（表驱动后该发的才发，此 400 直接透传）', async () => {
    const err = new Anthropic.APIError(400, { type: 'error', message: 'output_config not supported' }, 'bad', undefined)
    let callCount = 0
    const client = {
      messages: {
        create: async () => {
          callCount++
          throw err
        },
      },
    } as unknown as Anthropic
    // claude 系列发 effort（output_config）→ 网关仍 400 → 直接报错（不再剥 effort 重试）
    const evs = await collect(createAnthropicProvider({ ...CONF, model: 'claude-sonnet-5' } as ProviderConf, client), {
      ...REQ,
      effort: 'high',
    })
    expect(callCount).toBe(1) // 一次即止
    expect(evs[0]).toMatchObject({ type: 'error', retryable: false })
  })

  it('unknown 系列（anthropicEffortWire=null）不发 effort → 无降级', async () => {
    let callCount = 0
    const client = {
      messages: {
        create: async () => {
          callCount++
          // unknown 系列表不发 effort → 这里不会 400（验证表驱动后首发即对）
          return (async function* () {
            yield {
              type: 'message_delta',
              usage: { input_tokens: 1, output_tokens: 1 },
              delta: { stop_reason: 'end_turn' },
            }
          })()
        },
      },
    } as unknown as Anthropic
    const evs = await collect(createAnthropicProvider(CONF, client), { ...REQ, effort: 'high' })
    expect(callCount).toBe(1) // 首发即对，无降级
    expect(evs.some((e) => e.type === 'done')).toBe(true)
  })

  it('非 structured 相关的 400 不降级（直接报错）', async () => {
    const err = new Anthropic.APIError(400, { type: 'error', message: 'invalid model' }, 'invalid model', undefined)
    const client = { messages: { create: () => Promise.reject(err) } } as unknown as Anthropic
    const evs = await collect(createAnthropicProvider(CONF, client), REQ)
    expect(evs[0]).toMatchObject({ type: 'error', retryable: false })
  })
})

// ── A3（五十九轮）：降级记忆命中首发即剥 structured 成功 → done 带 degraded ─────────
// 修复背景：degraded 判据原为 attempt !== attempts[0]，记忆命中时首发即剥除参数面，
// 判据恒 false——Z-12 重放口径缺口在记忆命中路径（常态）全部漏标；改判 attempt !==
// plan.original 后，记忆命中的首发成功同样标 degraded。

describe('A3（五十九轮）：记忆命中首发剥除成功 → done 带 degraded', () => {
  it('anthropic：记忆命中 → 首发即剥 structured 且成功 → done.degraded = true', async () => {
    const client = {
      messages: {
        create: async () =>
          (async function* () {
            yield {
              type: 'message_delta',
              usage: { input_tokens: 1, output_tokens: 1 },
              delta: { stop_reason: 'end_turn' },
            }
          })(),
      },
    } as unknown as Anthropic
    const store: ProviderStore = {
      providers: [],
      currentId: null,
      currentModel: null,
      modelCaps: { 't1/claude-sonnet-5': { structured: false } },
      ragProviders: [],
      tiers: { creative: { model: '', effort: 'high' }, assistant: null, chat: null },
      revision: 0,
      vault: null,
      dek: null,
    }
    const prov = createAnthropicProvider({ ...CONF, model: 'claude-sonnet-5' } as ProviderConf, client, store)
    const evs = await collect(prov, { ...REQ, structured: { schema: {} } })
    const done = evs.find((e) => e.type === 'done') as { degraded?: boolean } | undefined
    expect(done).toBeDefined()
    expect(done!.degraded).toBe(true)
  })

  it('无记忆首发原样成功（attempt === original）→ done 不带 degraded（口径不泛化）', async () => {
    const client = {
      messages: {
        create: async () =>
          (async function* () {
            yield {
              type: 'message_delta',
              usage: { input_tokens: 1, output_tokens: 1 },
              delta: { stop_reason: 'end_turn' },
            }
          })(),
      },
    } as unknown as Anthropic
    const prov = createAnthropicProvider({ ...CONF, model: 'claude-sonnet-5' } as ProviderConf, client)
    const evs = await collect(prov, { ...REQ, structured: { schema: {} } })
    const done = evs.find((e) => e.type === 'done') as { degraded?: boolean } | undefined
    expect(done).toBeDefined()
    expect(done!.degraded).toBeUndefined()
  })
})
