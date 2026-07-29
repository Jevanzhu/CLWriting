import { apiJson } from './client'
import type { TreeNode } from '../types/tree'

// GET /api/books/:name/tree → {ok, nodes, revision, validatedAt}
export async function getTree(
  name: string,
): Promise<{ nodes: TreeNode[]; revision: string; validatedAt?: string }> {
  return apiJson(`/api/books/${encodeURIComponent(name)}/tree`)
}

// GET /config → {config}（book.yaml）。target_words 在 config.book.target_words。
export interface BookConfig {
  kind?: string
  book?: { title?: string; genre?: string; target_words?: number; [k: string]: unknown }
  /** 快照保留策略（单章版本回滚）；缺省 = 后端默认 14 天 / 30 个 */
  snapshots?: { max_days?: number; max_count?: number }
  [k: string]: unknown
}
export async function getConfig(name: string): Promise<BookConfig> {
  const r = await apiJson<{ config: BookConfig }>(
    `/api/books/${encodeURIComponent(name)}/config`,
  )
  return r.config
}

// PUT /config {config} → 全量写回 book.yaml（须传完整 config，服务端整文件重写）。
export async function putConfig(name: string, config: BookConfig): Promise<void> {
  await apiJson<{ ok: true }>(`/api/books/${encodeURIComponent(name)}/config`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ config }),
  })
}

// GET /words-diary → {date, baseline, delta}（§5.4 基线 + E4 精确增量；delta=null 表示当日无 settled 记录，回退 baseline）。
export async function getWordsDiary(
  name: string,
): Promise<{ date: string; baseline: number | null; delta: number | null }> {
  return apiJson(`/api/books/${encodeURIComponent(name)}/words-diary`)
}

// POST /words-diary {baseline} → 记今日基线（首次打开记当前已写）。
export async function postBaseline(name: string, baseline: number): Promise<void> {
  await apiJson(`/api/books/${encodeURIComponent(name)}/words-diary`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ baseline }),
  })
}
