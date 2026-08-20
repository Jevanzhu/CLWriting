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
 */
import { openSessionStore, bookHash } from '../events/store.js'
import type { LlmCallData } from '../events/types.js'
import { resolveModelPricing, computeCallCost } from './pricing.js'
import { localDayKey } from '../log/index.js'

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

interface CallEntry {
  task: string
  model: string
  chapter?: number
  usageIn: number
  usageOut: number
  cacheRead?: number
  cacheWrite?: number
  day: string
}

/** 从事件库读 llm/call（与 trace-stats 同源同容错；观测层失败静默 → []） */
function readLlmCalls(userDataPath: string | null | undefined, bookRoot: string): CallEntry[] {
  if (!userDataPath) return []
  try {
    const store = openSessionStore(userDataPath, bookRoot)
    if (!store) return []
    try {
      const events = store.listEvents(bookHash(bookRoot))
      const out: CallEntry[] = []
      for (const e of events) {
        if (e.type !== 'llm/call') continue
        const d = e.data as unknown as LlmCallData
        if (!d.ok) continue // 失败调用未产出——成本按成功调用口径统计（重试的成本在成功条目 attempt 里自然体现为多次调用）
        out.push({
          task: d.task,
          model: d.model,
          ...(typeof d.chapter === 'number' ? { chapter: d.chapter } : {}),
          usageIn: d.usage?.input ?? 0,
          usageOut: d.usage?.output ?? 0,
          ...(d.usage?.cacheRead !== undefined ? { cacheRead: d.usage.cacheRead } : {}),
          ...(d.usage?.cacheWrite !== undefined ? { cacheWrite: d.usage.cacheWrite } : {}),
          // M2（二轮复审）：本地日分桶（与日志文件日同口径；此前 UTC 切日，东八区 0-8 点记前一日）
          day: localDayKey(e.createdAt),
        })
      }
      return out
    } finally {
      store.close()
    }
  } catch {
    return []
  }
}

function bump(map: Record<string, CostBucket>, key: string, cost: number): void {
  const b = map[key] ?? { cost: 0, calls: 0 }
  b.cost = Math.round((b.cost + cost) * 1e10) / 1e10
  b.calls++
  map[key] = b
}

/** 聚合成本（无事件或全书无价格 → enabled:false 的空壳） */
export function aggregateCost(userDataPath: string | null | undefined, bookRoot: string): CostStats {
  const entries = readLlmCalls(userDataPath, bookRoot)
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
  if (currency) stats.currency = currency
  stats.unpricedModels = [...unpriced].filter((m) => !pricedSeen.has(m)).sort()
  return stats
}
