/** 书架 + 单书 API（对接 GET /api/books、GET /api/books/:name） */
import type { BookMeta } from '../types'

/** GET /api/books 响应 */
export interface ListBooksResponse {
  books: BookMeta[]
  workDir: boolean
  hint?: string
}

/** 书架列表（读 books.jsonl；workDir 为 null 时 books 空 + hint） */
export async function listBooks(): Promise<ListBooksResponse> {
  const r = await fetch('/api/books')
  if (!r.ok) throw new Error(`HTTP ${r.status}`)
  return (await r.json()) as ListBooksResponse
}
