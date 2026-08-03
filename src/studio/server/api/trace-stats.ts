/**
 * Trace 指标聚合只读端点（AI Harness T3）。
 *
 * GET /api/books/:name/trace-stats → { total, byTask }
 *
 * 薄接线——逻辑全在 metrics/trace-stats.ts。为第二波 UI 展示预留数据口。
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { join } from 'node:path'
import { route } from '../router.js'
import { reply } from '../http.js'
import { readBooks } from '../../../install/books.js'
import { aggregateTrace } from '../../../ai/trace-stats.js'

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
    reply(res, 200, stats)
  })
}
