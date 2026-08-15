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
import { join } from 'node:path'
import { route } from '../router.js'
import { reply } from '../http.js'
import { readBooks } from '../../../install/books.js'
import { searchBook } from '../../../process/book-search.js'

interface SearchCtx {
  workDir: string | null
}

export function registerSearchRoutes(ctx: SearchCtx): void {
  route('GET', '/api/books/:name/search', (req: IncomingMessage, res: ServerResponse, params) => {
    if (!ctx.workDir) return reply(res, 400, { error: '未定位到工作目录' })
    const entry = readBooks(ctx.workDir).find((b) => b.name === params['name'])
    if (!entry) return reply(res, 404, { error: `没有这本书：${params['name']}` })

    const url = new URL(req.url ?? '/', 'http://localhost')
    const q = (url.searchParams.get('q') ?? '').trim()
    const scope = url.searchParams.get('scope') ?? undefined
    const bookRoot = join(ctx.workDir, entry.path)

    const out = searchBook(bookRoot, q, scope)
    if (out.truncated) reply(res, 200, { results: out.results, truncated: true })
    else reply(res, 200, { results: out.results })
  })
}
