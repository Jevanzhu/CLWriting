/**
 * 书架 REST 端点（#12.3）。
 *
 * 1.1 占位：GET /api/books 返回空书架 { books: [] }。
 * 1.2 将改为读 books.jsonl，返回真实书籍列表。
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { route } from '../router.js'

/** 注册书架路由（在 server 启动时调用一次） */
export function registerBookRoutes(): void {
  // 1.1 占位：空书架；1.2 接 books.jsonl
  route('GET', '/api/books', (_req: IncomingMessage, res: ServerResponse) => {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ books: [] }))
  })
}
