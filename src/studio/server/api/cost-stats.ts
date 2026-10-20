/**
 * 成本统计端点：GET /api/books/:name/cost-stats。
 *
 * llm/call 事件 × providers.json 价格表聚合（按日/按章/按任务/累计）；
 * 全书无价格表 → { enabled: false }（前端显示「未配置价格」引导，不显示 0）。
 * ai-calls.json 不动（预算闸专用——数据源分工红线）。
 * 聚合是全事件库全量扫（llm/call 逐条流式 × 价格表），此前每次请求都重算——
 * 与 trace-stats 同族挂 5s TTL 结果缓存 + **数据源探针**（stats-signature.ts：
 * 事件库主库/`-wal` 侧车 + rule-hits 文件三指纹）——AI 任务收尾追加事件后即刻失效，
 * TTL 只兜探针照不到的面。缓存实例导出即观测面（生产零调用）。
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { defineRoute } from './schema.js'
import { reply } from '../http.js'
import { createTtlProbeCache } from '../ttl-cache.js'
import { statsSourceSignature } from './stats-signature.js'
import { registerBookKeyedCache } from '../../../shared/cache-registry.js' // 书键缓存登记表（登记制单源）
import { resolveBookOrReply } from '../book-context.js'
import { aggregateCost, type CostStats } from '../../../ai/cost-stats.js'

interface CostStatsCtx {
  workDir: string | null
  userDataPath: string | null
}

/** 缓存键：书根 + userDataPath（复合存储键 `bookRoot\0udp`——同进程多 server
 *  实例（测试/多库）各持数据目录，键不含它会让后启动实例读到前实例结果）。 */
interface CostStatsKey {
  bookRoot: string
  userDataPath: string | null
}

const COST_STATS_TTL = 5000
const COST_STATS_CACHE_MAX = 32

/** 结果缓存（书键；TTL 5s + 数据源探针、FIFO 32）——命中/失效时序断言读本实例 stats()/has()。 */
export const costStatsCache = createTtlProbeCache<CostStatsKey, CostStats>({
  name: 'cost-stats',
  keyOf: (k) => `${k.bookRoot}\u0000${k.userDataPath ?? ''}`,
  max: COST_STATS_CACHE_MAX,
  ttl: () => COST_STATS_TTL,
  probe: (k) => statsSourceSignature(k.userDataPath, k.bookRoot),
})

/** 删书/改名失效挂点（books-lifecycle 聚合入口接线；前缀清 ——
 *  同书各 userDataPath 键一并失效；TTL 5s 兜底自愈）。 */
export function forgetCostStatsCache(bookRoot: string): void {
  costStatsCache.forgetPrefix(bookRoot)
}

// 登记制（模块顶层自登记）：删/改名后同名重建书不读陈 stats 结果。
registerBookKeyedCache('cost-stats', forgetCostStatsCache)

export function registerCostStatsRoutes(ctx: CostStatsCtx): void {
  defineRoute('books.cost-stats', {
    method: 'GET',
    path: '/api/books/:name/cost-stats',
    // aggregateCost 转异步（事件库开库异步孪生），handler 随迁
    handler: async ({ params }, _req: IncomingMessage, res: ServerResponse) => {
      const r = resolveBookOrReply(ctx.workDir, params['name'], res)
      if (!r) return
      const key: CostStatsKey = { bookRoot: r.bookRoot, userDataPath: ctx.userDataPath }
      reply(res, 200, await costStatsCache.get(key, (k) => aggregateCost(k.userDataPath, k.bookRoot)))
    },
  })
}
