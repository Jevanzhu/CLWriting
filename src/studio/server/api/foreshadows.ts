/**
 * 伏笔/线索追踪 REST 端点。
 *
 * GET /api/books/:name/foreshadows → 伏笔列表（结构化 fm + 足迹 + 风险）
 *
 * 数据源：定稿/设定/伏笔/*.md，front matter（标题/状态/埋设章号/回收章号/重要性/关联词）。
 * 足迹扫描由 document/foreshadow.ts 完成（本地正文 grep，零 AI）。
 * CRUD 复用 documents 端点（伏笔就是 md 文件）。
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { join } from 'node:path'
import { route } from '../router.js'
import { reply } from '../http.js'
import { readBooks } from '../../../install/books.js'
import { readForeshadows, scanForeshadowTrails } from '../../../document/foreshadow.js'

interface ForeshadowCtx {
  workDir: string | null
}

export function registerForeshadowRoutes(ctx: ForeshadowCtx): void {
  // 伏笔列表（fm 字段 + 正文足迹 + 风险评估）
  route('GET', '/api/books/:name/foreshadows', (_req: IncomingMessage, res: ServerResponse, params) => {
    if (!ctx.workDir) return reply(res, 400, { error: '未定位到工作目录' })
    const entry = readBooks(ctx.workDir).find((b) => b.name === params['name'])
    if (!entry) return reply(res, 404, { error: `没有这本书:${params['name']}` })
    const bookRoot = join(ctx.workDir, entry.path)
    const entries = readForeshadows(bookRoot)
    const trails = scanForeshadowTrails(bookRoot, entries)
    reply(res, 200, entries.map((e) => ({ ...e, 足迹: trails.get(e.标题) ?? null })))
  })
}
