/**
 * Trace 指标聚合只读端点（AI Harness T3 + B3 规则命中统计）。
 *
 * GET /api/books/:name/trace-stats → { total, byTask, ruleHits }
 *
 * 薄接线——逻辑全在 trace-stats.ts / rule-hits.ts。B3 顺带透出规则命中统计。
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { join } from 'node:path'
import { route } from '../router.js'
import { reply } from '../http.js'
import { readBooks } from '../../../install/books.js'
import { aggregateTrace } from '../../../ai/trace-stats.js'
import { readRuleHits } from '../../../ai/rule-hits.js'

interface TraceStatsCtx {
  workDir: string | null
}

export function registerTraceStatsRoutes(ctx: TraceStatsCtx): void {
  route('GET', '/api/books/:name/trace-stats', (_req: IncomingMessage, res: ServerResponse, params) => {
    if (!ctx.workDir) return reply(res, 400, { error: '未定位到工作目录' })
    const entry = readBooks(ctx.workDir).find((b) => b.name === params['name'])
    if (!entry) return reply(res, 404, { error: `没有这本书：${params['name']}` })

    const bookRoot = join(ctx.workDir, entry.path)
    const stats = aggregateTrace(bookRoot)
    // B3：规则命中统计（按 hits 降序）
    reply(res, 200, { ...stats, ruleHits: readRuleHits(bookRoot) })
  })
}
