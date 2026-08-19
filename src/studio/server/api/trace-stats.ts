/**
 * Trace 指标聚合只读端点（AI Harness T3 + B3 规则命中统计）。
 *
 * GET /api/books/:name/trace-stats → { total, byTask, ruleHits }
 *
 * 薄接线——逻辑全在 trace-stats.ts / rule-hits.ts。B3 顺带透出规则命中统计。
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { defineRoute } from './schema.js'
import { reply, replyError } from '../http.js'
import { resolveBook } from '../book-context.js'
import { aggregateTrace } from '../../../ai/trace-stats.js'
import { readRuleHits } from '../../../ai/rule-hits.js'

interface TraceStatsCtx {
  workDir: string | null
  /** P2：事件库所在 APP 数据目录（trace 已由 llm/call 事件承载） */
  userDataPath: string | null
}

export function registerTraceStatsRoutes(ctx: TraceStatsCtx): void {
  defineRoute('books.trace-stats', {
    method: 'GET',
    path: '/api/books/:name/trace-stats',
    handler: ({ params }, _req: IncomingMessage, res: ServerResponse) => {
    const r = resolveBook(ctx.workDir, params['name'])
    if ('error' in r) return replyError(res, r.status, r.code, r.error)

    const bookRoot = r.bookRoot
    // P2：从事件库 llm/call 派生（接口不变；userDataPath 缺失 → total=0）
    const stats = aggregateTrace(ctx.userDataPath, bookRoot)
    // B3：规则命中统计（按 hits 降序）
    reply(res, 200, { ...stats, ruleHits: readRuleHits(bookRoot) })
  },
  })
}
