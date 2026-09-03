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
 */
import { openSessionStoreAsync, bookHash } from '../events/store.js'
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

/** 从事件库读 llm/call（与 trace-stats 同源同容错；观测层失败静默 → []）
 *  R34D-19（三十四轮）：转 async——开库走 openSessionStoreAsync（首开锁等待不阻塞
 *  服务事件循环），aggregateCost 随迁异步（端点/测试调用方 await）。 */
async function readLlmCalls(userDataPath: string | null | undefined, bookRoot: string): Promise<CallEntry[]> {
  if (!userDataPath) return []
  try {
    const store = await openSessionStoreAsync(userDataPath, bookRoot)
    if (!store) return []
    try {
      // B1（2026-08-24 内存闸）：type SQL 下推（同 trace-stats——只取 llm/call 行）
      const events = store.listEvents(bookHash(bookRoot), undefined, undefined, 'llm/call')
      const out: CallEntry[] = []
      for (const e of events) {
        const d = e.data as unknown as LlmCallData
        // Q-12（第十五轮）：判跳改看 usage 而非 ok——失败调用可携真实 usage（O-5 边界中断
        // 入账等），按 ok 剔除会让报表系统性低于预算闸口径/真实账单；失败且无 usage（多数
        // 失败响应客观不可得）仍跳过。带 usage 的失败调用按真实消耗折算，与预算闸对齐
        if (d.usage == null) continue
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
export async function aggregateCost(userDataPath: string | null | undefined, bookRoot: string): Promise<CostStats> {
  const entries = await readLlmCalls(userDataPath, bookRoot)
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
