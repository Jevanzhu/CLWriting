/**
 * Trace 指标聚合（AI Harness T3）。
 *
 * 从事件库（读侧单源 llm-call-read，重评2-P3-2 前为本模块私有 readLlmCalls）聚合产出统计 JSON：
 * 按 task 分组的通过率 / 平均 attempt / 耗时 p50-p95 / token 合计与趋势（按天）。
 *
 * 不做 UI（第二波）；本模块只产数据，由 API 端点薄接线透出。
 */
// 重评2-P3-2（2026-09-09 全量重评 GLM-5.3，AI 域 P3-③）：读侧单源化——原私有
// readLlmCalls 与 cost-stats 同构（开库/type 下推/投影/静默容错四处抄写），收敛至
// llm-call-read.ts 单源；本模块口径 = skipMissingUsage: false（无 usage 行也计入，
// token 按 ?? 0 兜底、行数即调用次数——通过率/耗时维度不依赖 usage）
import { readLlmCallRows } from './llm-call-read.js'

/** 单个 task 的聚合统计 */
export interface TaskStat {
  count: number
  /** 通过率（ok=true 比例） */
  successRate: number
  /** 平均 attempt（含首次 = 0） */
  avgAttempts: number
  /** 耗时 p50 / p95（ms） */
  durationP50: number
  durationP95: number
  /** token 合计 */
  totalInputTokens: number
  totalOutputTokens: number
  /** 按天趋势 */
  byDay: Record<string, { count: number; successRate: number; tokens: number }>
}

/** 全部 trace 的聚合统计 */
export interface TraceStats {
  total: number
  byTask: Record<string, TaskStat>
}

/** 百分位（输入需排序） */
function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0
  const idx = Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)
  return sorted[Math.max(0, idx)]!
}

/**
 * 聚合 trace 数据。
 *
 * @param bookRoot 书库根路径
 * @returns 聚合统计（无数据时 total=0）
 */
export async function aggregateTrace(userDataPath: string | null | undefined, bookRoot: string): Promise<TraceStats> {
  // 重评2-P3-2：读侧走 llm-call-read 单源（原注释：P2 起 trace 以事件库 llm/call 为
  // 单一事实源；观测层失败静默 → []；按事件创建时间聚日）。skipMissingUsage: false
  // 即原口径——无 usage 行不跳过，token 按 0 兜底计入。
  const entries = await readLlmCallRows(userDataPath, bookRoot, { skipMissingUsage: false })
  if (entries.length === 0) return { total: 0, byTask: {} }

  // 按 task 分组
  const groups = new Map<string, typeof entries>()
  for (const e of entries) {
    const arr = groups.get(e.task) ?? []
    arr.push(e)
    groups.set(e.task, arr)
  }

  const byTask: Record<string, TaskStat> = {}
  for (const [task, list] of groups) {
    const count = list.length
    const okCount = list.filter((e) => e.ok).length
    const durations = list.map((e) => e.durationMs).sort((a, b) => a - b)
    const totalAttempts = list.reduce((sum, e) => sum + e.attempt, 0)
    const totalIn = list.reduce((sum, e) => sum + e.usageIn, 0)
    const totalOut = list.reduce((sum, e) => sum + e.usageOut, 0)

    // 按天聚合
    const byDay: Record<string, { count: number; ok: number; tokens: number }> = {}
    for (const e of list) {
      const day = e.day
      const d = byDay[day] ?? { count: 0, ok: 0, tokens: 0 }
      d.count++
      if (e.ok) d.ok++
      d.tokens += e.usageIn + e.usageOut
      byDay[day] = d
    }

    const byDayFinal: Record<string, { count: number; successRate: number; tokens: number }> = {}
    for (const [day, d] of Object.entries(byDay)) {
      byDayFinal[day] = { count: d.count, successRate: d.ok / d.count, tokens: d.tokens }
    }

    byTask[task] = {
      count,
      successRate: okCount / count,
      avgAttempts: totalAttempts / count,
      durationP50: percentile(durations, 0.5),
      durationP95: percentile(durations, 0.95),
      totalInputTokens: totalIn,
      totalOutputTokens: totalOut,
      byDay: byDayFinal,
    }
  }

  return { total: entries.length, byTask }
}
