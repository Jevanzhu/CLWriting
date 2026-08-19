/**
 * 体检 REST 端点（#12.3 + 7.1）。
 *
 * - GET /api/books/:name/health/style     文风（aggregateStyleTrend → StyleTrend）
 *
 * 复用内核聚合函数，直接返结构化对象（不走人话 format）。后端零新增逻辑。
 * 空书（count=0）照常返对象，前端渲染空态。
 */
import { route } from '../router.js'
import { reply, replyError } from '../http.js'
import { readKind, resolveBook } from '../book-context.js'
import { scanChapters, aggregateStyleTrend, readBaseline } from '../../../metrics/style.js'

interface HealthCtx {
  workDir: string | null
}

/** 注册体检路由（server 启动时调用一次） */
export function registerHealthRoutes(ctx: HealthCtx): void {
  // 文风
  route('GET', '/api/books/:name/health/style', (_req, res, params) => {
    const r = resolveBook(ctx.workDir, params['name'])
    if ('error' in r) return replyError(res, r.status, r.code, r.error)
    const kind = readKind(r.bookRoot)
    const samples = scanChapters(r.bookRoot)
    reply(res, 200, aggregateStyleTrend(samples, kind, readBaseline(r.bookRoot)))
  })
}
