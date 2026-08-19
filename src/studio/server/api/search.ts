/**
 * 搜索端点（§19.1，W2A 收尾）：全书 .md 扫描，YAGNI 不引 FTS。
 *
 * GET /api/books/:name/search?q=&scope=all|定稿|设定|大纲|工作区
 *   → { results: [{path, matches: [{line, text}]}], truncated? }
 *
 * 实现已下沉 src/process/book-search.ts（对话助手 book_search 工具共用，
 * 不复制逻辑）；本文件只做 HTTP 壳。
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { defineRoute } from './schema.js'
import { reply, replyError } from '../http.js'
import { resolveBook } from '../book-context.js'
import { searchBook } from '../../../process/book-search.js'

interface SearchCtx {
  workDir: string | null
}

export function registerSearchRoutes(ctx: SearchCtx): void {
  defineRoute('books.search', {
    method: 'GET',
    path: '/api/books/:name/search',
    handler: ({ params }, req: IncomingMessage, res: ServerResponse) => {
    const r = resolveBook(ctx.workDir, params['name'])
    if ('error' in r) return replyError(res, r.status, r.code, r.error)

    const url = new URL(req.url ?? '/', 'http://localhost')
    const q = (url.searchParams.get('q') ?? '').trim()
    const scope = url.searchParams.get('scope') ?? undefined
    const bookRoot = r.bookRoot

    const out = searchBook(bookRoot, q, scope)
    if (out.truncated) reply(res, 200, { results: out.results, truncated: true })
    else reply(res, 200, { results: out.results })
  },
  })
}
