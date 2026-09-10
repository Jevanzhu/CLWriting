import { apiJson } from './client'

// GET /search?q=&scope=（细案 §2.1；scope∈all/定稿/正文/设定/大纲/工作区）。
export interface SearchHit {
  path: string
  matches: { line: number; text: string }[]
  // R1010c-FE1-P3-3（2026-09-10 全量独立复审修复批）：服务端单文件命中 20 条封顶的
  // 截断标记（R72-9，src/process/book-search.ts）——面板据此以「20+」文案区分服务端截断
  hasMore?: boolean
}
export async function search(
  name: string,
  q: string,
  scope: string,
): Promise<{ results: SearchHit[]; truncated?: boolean }> {
  return apiJson<{ results: SearchHit[]; truncated?: boolean }>(
    `/api/books/${encodeURIComponent(name)}/search?q=${encodeURIComponent(q)}&scope=${encodeURIComponent(scope)}`,
  )
}
