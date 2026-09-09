/**
 * D2（批 5）用量成本聚合——llm/call 事件 × 价格表。
 *
 * 数据源分工（原则，方向方案 §五）：`.cache/ai-calls.json` 只服务预算闸（当前态）；
 * `llm/call` 事件（append-only）是一切历史聚合与可视化的唯一真源——本模块只读事件。
 *
 * 金额口径：每条 llm/call 按其 model 查 resolveModelPricing（provider 级 +
 * models[] 级覆盖）四档分计（input/output/cacheRead/cacheWrite）；未配价的模型
 * 计入 unpricedModels 不折算（宁缺毋滥，不拿 0 冒充成本）。全书无任何价格表 →
 * enabled=false（前端显示「未配置价格」引导，不显示 0）。
 * 展示粒度对齐作者心智：按日 / 按章（事件 chapter 字段，D2 起 runTask 记录）/
 * 按任务 / 本书累计。
 *
 * 历史口径边界（M-1，2026-08-21）：OpenAI 兼容线的旧事件 usage.input 已含 cache 命中
 * （修复前口径），其后事件为归一口径（input 不含 cacheRead）——跨边界累计前段偏高。
 * 事件库 append-only 不做迁移；确需精确口径可按事件时间切分。
 * 历史成本计价口径（R50-B-4，五十轮）：aggregateCost 按当前价格表现算历史事件（事件
 * 不落价格快照），价格表调整后 byDay/byChapter 等历史数字随之漂移——与「重放可精确
 * 重建」守则的口径差以此声明（预算闸侧 ai-calls.json 调用时即落 cost，不受影响）；
 * 在 llm/call 事件随记 pricing 指纹（版本/单价）属后续增强。
 */
import { resolveModelPricing, computeCallCost } from './pricing.js'
// 重评2-P3-2（2026-09-09 全量重评 GLM-5.3，AI 域 P3-③）：读侧单源化——原私有
// readLlmCalls 与 trace-stats 同构（开库/type 下推/投影/静默容错四处抄写），收敛至
// llm-call-read.ts 单源；本模块口径 = skipMissingUsage: true（Q-12：无 usage 行跳过）
import { readLlmCallRows, type LlmCallReadRow } from './llm-call-read.js'

/** 单维度聚合条目 */
export interface CostBucket {
  cost: number
  /** 该桶内已配价计费的事件数 */
  calls: number
}

export interface CostStats {
  /** false = 全书无价格表（前端引导配置，不显示 0） */
  enabled: boolean
  /** 币种（首个命中价格表的 currency；缺省 'USD'） */
  currency?: string
  total: number
  byDay: Record<string, CostBucket>
  byTask: Record<string, CostBucket>
  byChapter: Record<string, CostBucket>
  /** 出现过但未配价、未折算的模型（引导补价格表） */
  unpricedModels: string[]
}

/**
 * 重评2-P3-2：行类型随读侧单源化收敛为 LlmCallReadRow（原私有 CallEntry 与单源
 * 投影字段重合——task/model/chapter?/usageIn/usageOut/cacheRead?/cacheWrite?/day；
 * ok/durationMs/attempt 为 trace 侧同源字段，本模块不消费）。
 */
type CallEntry = LlmCallReadRow

function bump(map: Record<string, CostBucket>, key: string, cost: number): void {
  const b = map[key] ?? { cost: 0, calls: 0 }
  b.cost = Math.round((b.cost + cost) * 1e10) / 1e10
  b.calls++
  map[key] = b
}

/** 聚合成本（无事件或全书无价格 → enabled:false 的空壳） */
export async function aggregateCost(userDataPath: string | null | undefined, bookRoot: string): Promise<CostStats> {
  // 重评2-P3-2：读侧走 llm-call-read 单源；skipMissingUsage: true 即原 Q-12 口径
  //（失败调用可携真实 usage 入账，失败且无 usage 才跳过——报表不系统性低于预算闸）
  const entries: CallEntry[] = await readLlmCallRows(userDataPath, bookRoot, { skipMissingUsage: true })
  const stats: CostStats = { enabled: false, total: 0, byDay: {}, byTask: {}, byChapter: {}, unpricedModels: [] }
  if (entries.length === 0) return stats

  const unpriced = new Set<string>()
  const pricedSeen = new Set<string>()
  let currency: string | undefined
  const pricingCache = new Map<string, ReturnType<typeof resolveModelPricing>>()

  for (const e of entries) {
    let pricing = pricingCache.get(e.model)
    if (pricing === undefined) {
      pricing = resolveModelPricing(userDataPath, e.model)
      pricingCache.set(e.model, pricing)
    }
    if (!pricing) {
      unpriced.add(e.model)
      continue
    }
    pricedSeen.add(e.model)
    if (!currency) currency = pricing.currency
    const cost = computeCallCost(pricing, {
      inputTokens: e.usageIn,
      outputTokens: e.usageOut,
      ...(e.cacheRead !== undefined ? { cacheReadTokens: e.cacheRead } : {}),
      ...(e.cacheWrite !== undefined ? { cacheWriteTokens: e.cacheWrite } : {}),
    }) ?? 0
    stats.total = Math.round((stats.total + cost) * 1e10) / 1e10
    bump(stats.byDay, e.day, cost)
    bump(stats.byTask, e.task, cost)
    if (e.chapter !== undefined) bump(stats.byChapter, String(e.chapter), cost)
  }

  stats.enabled = pricedSeen.size > 0
  // R42-22（四十二轮）：currency 缺省 'USD' 落地接口注释承诺——前端消费方（WbUsageCard）
  // 同款 ?? 'USD' 兜底，服务端补缺省后两侧一致；无事件的空壳早返，保持无字段（无计价语境）
  stats.currency = currency ?? 'USD'
  // R33-24（三十三轮）：定价解析按 model 缓存且确定性——入 unpriced 者必先 continue
  // 不可能再入 pricedSeen，原 filter 恒真条件为不可达冗余，径直展开。
  stats.unpricedModels = [...unpriced].sort()
  return stats
}
