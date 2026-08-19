/**
 * 伏笔/线索追踪 REST 端点。
 *
 * GET /api/books/:name/foreshadows → 伏笔列表（结构化 fm + 足迹 + 风险）
 *
 * 数据源：设定/伏笔/*.md，front matter（标题/状态/埋设章号/回收章号/重要性/关联词）。
 * 足迹扫描由 document/foreshadow.ts 完成（本地正文 grep，零 AI）。
 * CRUD 复用 documents 端点（伏笔就是 md 文件）。
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { defineRoute } from './schema.js'
import { reply, replyError } from '../http.js'
import { resolveBook } from '../book-context.js'
import { readForeshadows, scanForeshadowTrails, searchForeshadowTrails } from '../../../document/foreshadow.js'

interface ForeshadowCtx {
  workDir: string | null
}

export function registerForeshadowRoutes(ctx: ForeshadowCtx): void {
  // 伏笔列表（fm 字段 + 正文足迹 + 风险评估）
  defineRoute('books.foreshadows', {
    method: 'GET',
    path: '/api/books/:name/foreshadows',
    handler: ({ params }, _req: IncomingMessage, res: ServerResponse) => {
    const r = resolveBook(ctx.workDir, params['name'])
    if ('error' in r) return replyError(res, r.status, r.code, r.error)
    const bookRoot = r.bookRoot
    // F1-P3：?q= 走伏笔足迹 FTS 检索（标题/关联词/命中片段）；缺省全量 + 足迹
    const q = new URL(_req.url ?? '', 'http://local').searchParams.get('q') ?? undefined
    if (q) {
      reply(res, 200, searchForeshadowTrails(bookRoot, q))
      return
    }
    const entries = readForeshadows(bookRoot)
    const trails = scanForeshadowTrails(bookRoot, entries)
    reply(res, 200, entries.map((e) => ({ ...e, 足迹: trails.get(e.标题) ?? null })))
  },
  })
}
