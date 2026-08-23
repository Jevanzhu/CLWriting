/**
 * D2+D3（批 5）价格表与预算双口径测试：
 * - pricing 解析（provider 级 / models 级覆盖 / 未配 → null）与单次金额计算
 * - checkAiCallBudget 三口径（次数 / tokens 全口径 / cost 需配价才生效）
 * - effectiveRemainingCalls 三口径取最紧
 * - recordAiCall 金额累计
 * - cost-stats 聚合（按日/按章/按任务；未配价 enabled:false + unpricedModels）
 * - providers pricing 端点（写/清/非法值 400/不影响 caps）
 * - budget 双口径键解析与序列化 round-trip + global 托底
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pricingForProvider, computeCallCost, resolveModelPricing } from '../../src/ai/pricing.js'
import { checkAiCallBudget, effectiveRemainingCalls, recordAiCall } from '../../src/ai/calls.js'
import { aggregateCost } from '../../src/ai/cost-stats.js'
import { saveProviders, type ProviderStore } from '../../src/ai/provider/store.js'
import { openSessionStore, bookHash } from '../../src/events/store.js'
import { writeBookConfig, parseBookConfig } from '../../src/format/yaml.js'
import { applyGlobalDefaults } from '../../src/format/global-defaults.js'
import type { ProviderConf } from '../../src/ai/provider/types.js'
import type { BookConfig } from '../../src/format/types.js'

const dirs: string[] = []

function tmpDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(d)
  return d
}

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

// ── pricing 解析与计算 ───────────────────────────────────────────────

describe('D2 pricing 解析与金额计算', () => {
  const baseProvider = (over: Partial<ProviderConf>): ProviderConf =>
    ({
      id: 'p1',
      name: '测试',
      protocol: 'openai',
      auth: 'bearer',
      baseUrl: 'https://x.local',
      apiKey: 'sk-x',
      ...over,
    }) as ProviderConf

  it('provider 级价格生效；models 级同名键覆盖；都未配 → null', () => {
    const unpriced = pricingForProvider(baseProvider({}), 'm1')
    expect(unpriced).toBeNull()
    const providerLevel = pricingForProvider(baseProvider({ pricing: { inputPerMTok: 3, outputPerMTok: 15 } }), 'm1')
    expect(providerLevel).toEqual({ inputPerMTok: 3, outputPerMTok: 15 })
    const overridden = pricingForProvider(
      baseProvider({
        pricing: { inputPerMTok: 3, outputPerMTok: 15 },
        models: [{ id: 'm1', pricing: { inputPerMTok: 1 } }],
      }),
      'm1',
    )
    expect(overridden).toEqual({ inputPerMTok: 1, outputPerMTok: 15 })
    // 其他模型行不误伤
    const other = pricingForProvider(
      baseProvider({ models: [{ id: 'm2', pricing: { inputPerMTok: 1 } }] }),
      'm1',
    )
    expect(other).toBeNull()
  })

  it('computeCallCost 四档分计；未配价 → null', () => {
    const pricing = { inputPerMTok: 3, outputPerMTok: 15, cacheReadPerMTok: 0.3, cacheWritePerMTok: 3.75 }
    const cost = computeCallCost(pricing, {
      inputTokens: 1_000_000,
      outputTokens: 200_000,
      cacheReadTokens: 2_000_000,
      cacheWriteTokens: 400_000,
    })!
    expect(cost).toBeCloseTo(3 + 3 + 0.6 + 1.5, 8)
    expect(computeCallCost(null, { inputTokens: 100, outputTokens: 100 })).toBeNull()
  })

  // M-1：OpenAI 线 usage 已在适配器边界归一成「inputTokens 不含 cache 命中」——同一
  // 份四档公式对两协议同时成立。锚：OpenAI 真实 50 prompt（40 命中）= 归一 10+40，
  // 金额 = 10×input价 + 40×cache读价，不得再按 50×input价 + 40×cache读价 双计
  it('M-1 归一口径：OpenAI 形态（50 prompt / 40 cached）金额按 10×input + 40×cacheRead 计', () => {
    const pricing = { inputPerMTok: 3, outputPerMTok: 15, cacheReadPerMTok: 0.3 }
    const cost = computeCallCost(pricing, { inputTokens: 10, outputTokens: 3, cacheReadTokens: 40 })!
    expect(cost).toBeCloseTo((10 * 3 + 40 * 0.3 + 3 * 15) / 1e6, 12)
    const doubleCounted = computeCallCost(pricing, { inputTokens: 50, outputTokens: 3, cacheReadTokens: 40 })!
    expect(cost).toBeLessThan(doubleCounted) // 修复前口径虚高一个命中量
  })

  it('resolveModelPricing：models[] 归属优先 → 当前 provider 兜底；无 → null', () => {
    const ud = tmpDir('clw-pricing-ud-')
    const store: ProviderStore = {
      providers: [
        {
          id: 'p1',
          name: 'A',
          protocol: 'openai',
          auth: 'bearer',
          baseUrl: 'https://a.local',
          apiKey: 'sk-a',
          pricing: { inputPerMTok: 3 },
          models: [{ id: 'model-a', pricing: { inputPerMTok: 1 } }],
        },
        { id: 'p2', name: 'B', protocol: 'openai', auth: 'bearer', baseUrl: 'https://b.local', apiKey: 'sk-b' },
      ],
      currentId: 'p2',
      tiers: { creative: { model: 'model-b', effort: 'high' }, assistant: null, chat: null },
      currentModel: 'model-b',
      revision: 0,
      modelCaps: {},
    } as unknown as ProviderStore
    saveProviders(ud, store)
    expect(resolveModelPricing(ud, 'model-a')).toEqual({ inputPerMTok: 1 }) // 归属行覆盖 provider 级
  })

  it('resolveModelPricing：当前 provider 无价且无归属行 → null（不跨 provider 拿价）', () => {
    const ud = tmpDir('clw-pricing-ud2-')
    const store: ProviderStore = {
      providers: [
        { id: 'p1', name: 'A', protocol: 'openai', auth: 'bearer', baseUrl: 'https://a.local', apiKey: 'sk-a', pricing: { inputPerMTok: 3 } },
        { id: 'p2', name: 'B', protocol: 'openai', auth: 'bearer', baseUrl: 'https://b.local', apiKey: 'sk-b' },
      ],
      currentId: 'p2',
      tiers: { creative: { model: 'model-b', effort: 'high' }, assistant: null, chat: null },
      currentModel: 'model-b',
      revision: 0,
      modelCaps: {},
    } as unknown as ProviderStore
    saveProviders(ud, store)
    expect(resolveModelPricing(ud, 'model-b')).toBeNull()
    expect(resolveModelPricing(ud, '')).toBeNull()
    expect(resolveModelPricing(null, 'model-b')).toBeNull()
  })

  // 第五轮 B-2：归属行存在但归属 provider 未配价 → 必须是未配价（null）——旧实现继续
  // 落到「当前 provider」的价格表，A 家模型按 B 家单价折算成本/预算，切 provider 还会
  // 追溯改写历史折算价。currentId 失效同理不得静默拿第一家兜底。
  it('resolveModelPricing：归属 provider 未配价 / currentId 失效 → null（不借价、不拿第一家兜底）', () => {
    const ud = tmpDir('clw-pricing-ud3-')
    const mk = (currentId: string): ProviderStore =>
      ({
        providers: [
          { id: 'p1', name: 'A', protocol: 'openai', auth: 'bearer', baseUrl: 'https://a.local', apiKey: 'sk-a', pricing: { inputPerMTok: 3 } },
          { id: 'p3', name: 'C', protocol: 'openai', auth: 'bearer', baseUrl: 'https://c.local', apiKey: 'sk-c', models: [{ id: 'model-c' }] },
        ],
        currentId,
        tiers: { creative: { model: 'model-x', effort: 'high' }, assistant: null, chat: null },
        currentModel: 'model-x',
        revision: 0,
        modelCaps: {},
      }) as unknown as ProviderStore
    // 当前启用 p1（有价）；model-c 归属 p3（未配价）→ null，不得按 p1 的 3 计价
    saveProviders(ud, mk('p1'))
    expect(resolveModelPricing(ud, 'model-c')).toBeNull()
    // currentId 指向已删除的 provider；model-x 无归属行 → null，不得拿第一家 p1 兜底
    saveProviders(ud, mk('gone'))
    expect(resolveModelPricing(ud, 'model-x')).toBeNull()
  })
})

// ── D3 预算双口径 ────────────────────────────────────────────────────

describe('D3 checkAiCallBudget 三口径', () => {
  let root = ''

  beforeEach(() => {
    root = tmpDir('clw-budget-')
    mkdirSync(join(root, '.cache'), { recursive: true })
  })

  const cfg = (over: Partial<BookConfig['budget']>): BookConfig =>
    ({ spec_version: 1, book: { title: 't' }, leads: { enabled: [] }, budget: { calls_per_chapter: 8, ...over }, growth: {} }) as BookConfig

  function writeRecord(chapter: number, used: number, fields: Record<string, number>): void {
    writeFileSync(
      join(root, '.cache', 'ai-calls.json'),
      JSON.stringify({ chapter: { num: chapter, used, inputTokens: 0, outputTokens: 0, ...fields }, tasks: {} }),
    )
  }

  it('tokens 口径：全口径累计（input+output+cache 读写）超限拦截，人话含出路', () => {
    writeRecord(3, 2, { inputTokens: 400_000, outputTokens: 50_000, cacheReadTokens: 100_000, cacheWriteTokens: 50_000 })
    const r = checkAiCallBudget(root, 3, cfg({ tokens_per_chapter: 500_000 }))
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.reason).toContain('600000 tokens')
      expect(r.reason).toContain('tokens_per_chapter')
    }
    // 未达限 → 放行且带用量
    const ok = checkAiCallBudget(root, 3, cfg({ tokens_per_chapter: 700_000 }))
    expect(ok.ok).toBe(true)
    if (ok.ok) expect(ok.usedTokens).toBe(600_000)
  })

  it('cost 口径：记账有 costAccum（已配价）才拦截——未配价静默不生效', () => {
    writeRecord(3, 2, { costAccum: 1.2 })
    const blocked = checkAiCallBudget(root, 3, cfg({ cost_per_chapter: 1 }))
    expect(blocked.ok).toBe(false)
    if (!blocked.ok) expect(blocked.reason).toContain('cost_per_chapter')
    // 未配价（无 costAccum 字段）→ 同样预算静默放行
    writeRecord(3, 2, {})
    const pass = checkAiCallBudget(root, 3, cfg({ cost_per_chapter: 1 }))
    expect(pass.ok).toBe(true)
  })

  it('次数口径不回归（先于双口径判定）', () => {
    writeRecord(3, 8, {})
    const r = checkAiCallBudget(root, 3, cfg({}))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain('上限 8')
  })

  it('effectiveRemainingCalls：三口径取最紧折算', () => {
    // 次剩 6/8（75% 剩），token 已用 90%（100k/…）→ 最紧 token → 剩 ≈ ceil(0.1*8)=1
    writeRecord(3, 2, { inputTokens: 90_000, outputTokens: 0 })
    expect(effectiveRemainingCalls(root, 3, cfg({ tokens_per_chapter: 100_000 }))).toBe(1)
    // 只有次数口径 → 8-2=6
    expect(effectiveRemainingCalls(root, 3, cfg({}))).toBe(6)
    // cost 最紧（用 95%）→ ceil(0.05*8)=1
    writeRecord(3, 2, { costAccum: 0.95 })
    expect(effectiveRemainingCalls(root, 3, cfg({ cost_per_chapter: 1 }))).toBe(1)
  })

  it('effectiveRemainingCalls：超限 → 0（三审降档不误判额度充足）', () => {
    // 次数口径耗尽（8/8 → ok=false）：此前误提前返回满额 limit，三审降档拿到
    // 「额度充足」不降档——与「取最紧折算剩余」的注释语义相反
    writeRecord(7, 8, {})
    expect(effectiveRemainingCalls(root, 7, cfg({}))).toBe(0)
    // token 口径超限（120k > 100k，次数未超）→ 同样 0
    writeRecord(8, 2, { inputTokens: 120_000, outputTokens: 0 })
    expect(effectiveRemainingCalls(root, 8, cfg({ tokens_per_chapter: 100_000 }))).toBe(0)
  })

  it('effectiveRemainingCalls：calls_per_chapter: 0 → 0（0/0 产出 NaN 等同额度无限）', () => {
    // 病态配置防 NaN：limit=0 且无记录时 0/0=NaN，下游一切比较恒 false
    expect(effectiveRemainingCalls(root, 9, cfg({ calls_per_chapter: 0 }))).toBe(0)
  })

  it('recordAiCall 金额累计（costUsd 传入时；浮点噪声 1e-10 归一）', () => {
    recordAiCall(root, 5, { inputTokens: 1000, outputTokens: 100 }, 0.1)
    recordAiCall(root, 5, { inputTokens: 1000, outputTokens: 100 }, 0.2)
    const raw = JSON.parse(readFileSync(join(root, '.cache', 'ai-calls.json'), 'utf8')) as { chapter: { costAccum: number; used: number } }
    expect(raw.chapter.used).toBe(2)
    expect(raw.chapter.costAccum).toBeCloseTo(0.3, 10)
    // 不传 cost → 不累计（已有值保持）
    recordAiCall(root, 5, { inputTokens: 100, outputTokens: 10 })
    const raw2 = JSON.parse(readFileSync(join(root, '.cache', 'ai-calls.json'), 'utf8')) as { chapter: { costAccum: number } }
    expect(raw2.chapter.costAccum).toBeCloseTo(0.3, 10)
  })
})

// ── D2 cost-stats 聚合 ───────────────────────────────────────────────

describe('D2 cost-stats 聚合', () => {
  it('llm/call × 价格表：按日/按章/按任务聚合；未配价模型进 unpricedModels', () => {
    const ud = tmpDir('clw-cost-ud-')
    const root = tmpDir('clw-cost-book-')
    const store: ProviderStore = {
      providers: [
        {
          id: 'p1', name: 'A', protocol: 'openai', auth: 'bearer', baseUrl: 'https://a.local', apiKey: 'sk-a',
          pricing: { inputPerMTok: 3, outputPerMTok: 15 },
        },
      ],
      currentId: 'p1',
      tiers: { creative: { model: 'model-x', effort: 'high' }, assistant: null, chat: null },
      currentModel: 'model-x',
      revision: 0,
      modelCaps: {},
    } as unknown as ProviderStore
    saveProviders(ud, store)

    const es = openSessionStore(ud, root)!
    try {
      const sessionId = es.createSession(bookHash(root))
      es.appendEvents(sessionId, [
        {
          type: 'llm/call',
          data: {
            runId: 'r1', task: 'self-heal', tierKind: 'creative', model: 'model-x', attempt: 0,
            stopReason: 'end', usage: { input: 1_000_000, output: 200_000 }, durationMs: 100, ok: true,
            chapter: 3,
          },
        },
        {
          type: 'llm/call',
          data: {
            runId: 'r2', task: 'outline', tierKind: 'creative', model: 'model-unpriced', attempt: 0,
            stopReason: 'end', usage: { input: 500_000, output: 0 }, durationMs: 50, ok: true,
          },
        },
        // 失败调用不计费
        {
          type: 'llm/call',
          data: { runId: 'r3', task: 'self-heal', tierKind: 'creative', model: 'model-x', attempt: 0, stopReason: 'error', durationMs: 10, ok: false },
        },
      ])
    } finally {
      es.close()
    }

    const stats = aggregateCost(ud, root)
    expect(stats.enabled).toBe(true)
    // model-x 命中 provider 级价（1M*3 + 0.2M*15 = 6）；model-unpriced 无归属行 →
    // 兜底当前 provider（p1，有价）按 provider 级计（0.5M*3 = 1.5）——网关下未知模型按网关价
    expect(stats.total).toBeCloseTo(7.5, 8)
    expect(stats.byTask['self-heal']!.cost).toBeCloseTo(6, 8)
    expect(stats.byTask['self-heal']!.calls).toBe(1)
    expect(stats.byTask['outline']!.cost).toBeCloseTo(1.5, 8)
    expect(stats.byChapter['3']!.cost).toBeCloseTo(6, 8) // outline 无 chapter → 不进按章
    expect(Object.keys(stats.byChapter)).toEqual(['3'])
    expect(Object.keys(stats.byDay)).toHaveLength(1)
    expect(stats.unpricedModels).toEqual([]) // 当前 provider 有价 → 兜底可计价
  })

  // Q-12（第十五轮）：判跳改看 usage——失败调用（边界中断等）可携真实 usage，
  // 按 ok 剔除会让报表系统性低于预算闸口径/真实账单
  it('Q-12: 失败调用带真实 usage → 计入聚合；失败且无 usage 仍跳过', () => {
    const ud = tmpDir('clw-cost-ud3-')
    const root = tmpDir('clw-cost-book3-')
    const store: ProviderStore = {
      providers: [
        {
          id: 'p1', name: 'A', protocol: 'openai', auth: 'bearer', baseUrl: 'https://a.local', apiKey: 'sk-a',
          pricing: { inputPerMTok: 3, outputPerMTok: 15 },
        },
      ],
      currentId: 'p1',
      tiers: { creative: { model: 'model-x', effort: 'high' }, assistant: null, chat: null },
      currentModel: 'model-x',
      revision: 0,
      modelCaps: {},
    } as unknown as ProviderStore
    saveProviders(ud, store)

    const es = openSessionStore(ud, root)!
    try {
      const sessionId = es.createSession(bookHash(root))
      es.appendEvents(sessionId, [
        // O-5 边界中断形态：ok:false 但 usage 已到手
        {
          type: 'llm/call',
          data: {
            runId: 'r1', task: 'self-heal', tierKind: 'creative', model: 'model-x', attempt: 0,
            stopReason: 'aborted', usage: { input: 1_000_000, output: 100_000 }, durationMs: 100, ok: false,
            chapter: 7,
          },
        },
        // 失败且无 usage（多数失败响应）——无从折算，仍跳过
        {
          type: 'llm/call',
          data: { runId: 'r2', task: 'self-heal', tierKind: 'creative', model: 'model-x', attempt: 0, stopReason: 'error', durationMs: 10, ok: false, chapter: 7 },
        },
      ])
    } finally {
      es.close()
    }

    const stats = aggregateCost(ud, root)
    expect(stats.enabled).toBe(true)
    // 带 usage 的失败调用按真实消耗折算（1M*3 + 0.1M*15 = 4.5）
    expect(stats.total).toBeCloseTo(4.5, 8)
    expect(stats.byTask['self-heal']!.calls).toBe(1)
    expect(stats.byChapter['7']!.cost).toBeCloseTo(4.5, 8)
  })

  it('全书无价格表 → enabled:false（不显示 0）', () => {
    const ud = tmpDir('clw-cost-ud2-')
    const root = tmpDir('clw-cost-book2-')
    const es = openSessionStore(ud, root)!
    try {
      const sessionId = es.createSession(bookHash(root))
      es.appendEvents(sessionId, [
        { type: 'llm/call', data: { runId: 'r1', task: 'self-heal', tierKind: 'creative', model: 'm', attempt: 0, stopReason: 'end', usage: { input: 100, output: 100 }, durationMs: 1, ok: true } },
      ])
    } finally {
      es.close()
    }
    const stats = aggregateCost(ud, root)
    expect(stats.enabled).toBe(false)
    expect(stats.total).toBe(0)
    expect(stats.unpricedModels).toEqual(['m'])
    // 空事件库同样 enabled:false
    expect(aggregateCost(ud, tmpDir('clw-cost-empty-')).enabled).toBe(false)
  })
})

// ── budget 键解析/序列化 + global 托底 ────────────────────────────────

describe('D3 budget 双口径键：解析/序列化/global 托底', () => {
  it('book.yaml round-trip：设了才输出，解析保真', () => {
    const root = tmpDir('clw-budget-yaml-')
    const cfg: BookConfig = {
      spec_version: 1, book: { title: 't' }, leads: { enabled: [] }, growth: {},
      budget: { calls_per_chapter: 8, tokens_per_chapter: 600_000, cost_per_chapter: 1.5 },
    } as BookConfig
    writeBookConfig(join(root, 'book.yaml'), cfg)
    const raw = readFileSync(join(root, 'book.yaml'), 'utf8')
    expect(raw).toContain('tokens_per_chapter: 600000')
    expect(raw).toContain('cost_per_chapter: 1.5')
    const parsed = parseBookConfig(raw, 'book.yaml')
    expect(parsed.ok).toBe(true)
    if (parsed.ok) {
      expect(parsed.config.budget.tokens_per_chapter).toBe(600_000)
      expect(parsed.config.budget.cost_per_chapter).toBe(1.5)
    }
  })

  it('applyGlobalDefaults：书级未设回落 global.tokensPerChapter/costPerChapter；书级覆盖赢', () => {
    const ud = tmpDir('clw-budget-global-')
    writeFileSync(join(ud, 'global.json'), JSON.stringify({ tokensPerChapter: 400_000, costPerChapter: 0.8 }))
    const cfg = { spec_version: 1, book: { title: 't' }, leads: { enabled: [] }, growth: {} } as unknown as BookConfig
    const merged = applyGlobalDefaults(cfg, ud)
    expect(merged.budget.tokens_per_chapter).toBe(400_000)
    expect(merged.budget.cost_per_chapter).toBe(0.8)
    const cfg2: BookConfig = { spec_version: 1, book: { title: 't' }, leads: { enabled: [] }, growth: {}, budget: { tokens_per_chapter: 900_000 } } as BookConfig
    const merged2 = applyGlobalDefaults(cfg2, ud)
    expect(merged2.budget.tokens_per_chapter).toBe(900_000)
    // 无 global 无书级 → undefined（不拦）
    const merged3 = applyGlobalDefaults({ spec_version: 1, book: { title: 't' }, leads: { enabled: [] }, growth: {} } as unknown as BookConfig, null)
    expect(merged3.budget.tokens_per_chapter).toBeUndefined()
  })
})
