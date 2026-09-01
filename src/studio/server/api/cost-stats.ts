/**
 * D2（批 5）成本统计端点：GET /api/books/:name/cost-stats。
 *
 * llm/call 事件 × providers.json 价格表聚合（按日/按章/按任务/累计）；
 * 全书无价格表 → { enabled: false }（前端显示「未配置价格」引导，不显示 0）。
 * ai-calls.json 不动（预算闸专用——数据源分工红线）。
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { defineRoute } from './schema.js'
import { reply, replyError } from '../http.js'
import { resolveBook } from '../book-context.js'
import { aggregateCost } from '../../../ai/cost-stats.js'

interface CostStatsCtx {
  workDir: string | null
  userDataPath: string | null
}

export function registerCostStatsRoutes(ctx: CostStatsCtx): void {
  defineRoute('books.cost-stats', {
    method: 'GET',
    path: '/api/books/:name/cost-stats',
    // R34D-19（三十四轮）：aggregateCost 转异步（事件库开库异步孪生），handler 随迁
    handler: async ({ params }, _req: IncomingMessage, res: ServerResponse) => {
      const r = resolveBook(ctx.workDir, params['name'])
      if ('error' in r) return replyError(res, r.status, r.code, r.error)
      reply(res, 200, await aggregateCost(ctx.userDataPath, r.bookRoot))
    },
  })
}
