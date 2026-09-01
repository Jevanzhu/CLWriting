/**
 * Trace 指标聚合（AI Harness T3）。
 *
 * 从事件库（openSessionStore → readLlmCalls）聚合产出统计 JSON：
 * 按 task 分组的通过率 / 平均 attempt / 耗时 p50-p95 / token 合计与趋势（按天）。
 *
 * 不做 UI（第二波）；本模块只产数据，由 API 端点薄接线透出。
 */
import { openSessionStoreAsync, bookHash } from '../events/store.js'
import type { LlmCallData } from '../events/types.js'
import { localDayKey } from '../log/index.js'

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

/** 取日期 key（YYYY-MM-DD，本地日——M2 二轮复审与日志/成本同口径） */
function dayKey(ts: number | string): string {
  return localDayKey(ts)
}

/**
 * 聚合 trace 数据。
 *
 * @param bookRoot 书库根路径
 * @returns 聚合统计（无数据时 total=0）
 */
/**
 * 从事件库读 llm/call 事件（P2：trace 单一事实源；观测层失败静默 → []）。
 * llm/call 事件挂 workspace 会话（bookHash(bookRoot) 为 book 标识），
 * 按事件创建时间聚日（createdAt 为 ms 时间戳）。
 */
function readLlmCalls(
  userDataPath: string | null | undefined,
  bookRoot: string,
): Promise<{
  task: string
  ok: boolean
  durationMs: number
  attempt: number
  usageIn: number
  usageOut: number
  day: string
}[]> {
  if (!userDataPath) return Promise.resolve([])
  // R34D-19（三十四轮）：转 async——开库走 openSessionStoreAsync（首开锁等待不阻塞
  // 服务事件循环），aggregateTrace 随迁异步（端点/测试调用方 await）。
  return openSessionStoreAsync(userDataPath, bookRoot)
    .then((store) => {
      if (!store) return []
      try {
        // B1（2026-08-24 内存闸）：type SQL 下推——只取 llm/call 行（原全量投影再内存过滤，
        // 全部对话正文一起 JSON.parse，峰值随书龄线性增长无上限）
        const events = store.listEvents(bookHash(bookRoot), undefined, undefined, 'llm/call')
        const out: {
          task: string
          ok: boolean
          durationMs: number
          attempt: number
          usageIn: number
          usageOut: number
          day: string
        }[] = []
        for (const e of events) {
          const d = e.data as unknown as LlmCallData
          out.push({
            task: d.task,
            ok: d.ok,
            durationMs: d.durationMs,
            attempt: d.attempt,
            usageIn: d.usage?.input ?? 0,
            usageOut: d.usage?.output ?? 0,
            day: dayKey(e.createdAt),
          })
        }
        return out
      } finally {
        store.close()
      }
    })
    .catch(() => [])
}

export async function aggregateTrace(userDataPath: string | null | undefined, bookRoot: string): Promise<TraceStats> {
  const entries = await readLlmCalls(userDataPath, bookRoot)
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
