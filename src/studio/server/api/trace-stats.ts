/**
 * Trace 指标聚合只读端点（AI 调用 + 规则命中统计）。
 *
 * GET /api/books/:name/trace-stats → { total, byTask, ruleHits }
 *
 * 薄接线——逻辑全在 trace-stats.ts / rule-hits.ts。顺带透出规则命中统计。
 * 聚合是全事件库全量扫（llm/call 逐条流式），此前每次请求都重算——
 * 工作台/诊断面轮询即反复读库。现挂 5s TTL 结果缓存 + **数据源探针**
 * （stats-signature.ts：事件库主库/`-wal` 侧车 + rule-hits 文件三指纹）：
 * AI 任务收尾追加事件或命中记账落盘后即刻失效，TTL 只兜探针照不到的面。
 * 缓存实例导出即观测面（生产零调用）。
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { defineRoute } from './schema.js'
import { reply } from '../http.js'
import { createTtlProbeCache } from '../ttl-cache.js'
import { statsSourceSignature } from './stats-signature.js'
import { registerBookKeyedCache } from '../cache-registry.js' // 书键缓存登记表（登记制单源）
import { resolveBookOrReply } from '../book-context.js'
import { aggregateTrace } from '../../../ai/trace-stats.js'
import { readRuleHits } from '../../../ai/rule-hits.js'

interface TraceStatsCtx {
  workDir: string | null
  /** 事件库所在 APP 数据目录（trace 已由 llm/call 事件承载） */
  userDataPath: string | null
}

/** 缓存键：书根 + userDataPath（复合存储键 `bookRoot\0udp`——同进程多 server
 *  实例（测试/多库）各持数据目录，键不含它会让后启动实例读到前实例结果）。 */
interface TraceStatsKey {
  bookRoot: string
  userDataPath: string | null
}

const TRACE_STATS_TTL = 5000
const TRACE_STATS_CACHE_MAX = 32

/** 结果缓存（书键；TTL 5s + 数据源探针、FIFO 32）——命中/失效时序断言读本实例 stats()/has()。 */
export const traceStatsCache = createTtlProbeCache<TraceStatsKey, Record<string, unknown>>({
  name: 'trace-stats',
  keyOf: (k) => `${k.bookRoot}\u0000${k.userDataPath ?? ''}`,
  max: TRACE_STATS_CACHE_MAX,
  ttl: () => TRACE_STATS_TTL,
  probe: (k) => statsSourceSignature(k.userDataPath, k.bookRoot),
})

/** 删书/改名失效挂点（books-lifecycle 聚合入口接线；前缀清 ——
 *  同书各 userDataPath 键一并失效；TTL 5s 兜底自愈）。 */
export function forgetTraceStatsCache(bookRoot: string): void {
  traceStatsCache.forgetPrefix(bookRoot)
}

// 登记制（模块顶层自登记）：删/改名后同名重建书不读陈 stats 结果。
registerBookKeyedCache('trace-stats', forgetTraceStatsCache)

export function registerTraceStatsRoutes(ctx: TraceStatsCtx): void {
  defineRoute('books.trace-stats', {
    method: 'GET',
    path: '/api/books/:name/trace-stats',
    // aggregateTrace 转异步（事件库开库异步孪生），handler 随迁
    handler: async ({ params }, _req: IncomingMessage, res: ServerResponse) => {
      const r = resolveBookOrReply(ctx.workDir, params['name'], res)
      if (!r) return

      const key: TraceStatsKey = { bookRoot: r.bookRoot, userDataPath: ctx.userDataPath }
      // 从事件库 llm/call 派生（接口不变；userDataPath 缺失 → total=0）
      const payload = await traceStatsCache.get(key, async (k) => {
        const stats = await aggregateTrace(k.userDataPath, k.bookRoot)
        // 规则命中统计（按 hits 降序）
        return { ...stats, ruleHits: readRuleHits(k.bookRoot) }
      })
      reply(res, 200, payload)
    },
  })
}
