import { apiJson } from './client'

// GET /search?q=&scope=（细案 §2.1；scope∈all/定稿/正文/设定/大纲/工作区）。
export interface SearchHit {
  path: string
  matches: { line: number; text: string }[]
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
