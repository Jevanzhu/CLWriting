import { apiJson } from './client'
import type { TreeNode } from '../types/tree'

// GET /api/books/:name/tree → {ok, nodes, revision, validatedAt}
// refresh=true：让服务端丢树缓存重扫盘（外部编辑器/CLI 改动才刷得出来）
export async function getTree(
  name: string,
  refresh = false,
): Promise<{ nodes: TreeNode[]; revision: string; validatedAt?: string }> {
  const q = refresh ? '?refresh=1' : ''
  return apiJson(`/api/books/${encodeURIComponent(name)}/tree${q}`)
}

// GET /config → {config}（book.yaml）。target_words 在 config.book.target_words。
export interface BookConfig {
  kind?: 'long' | 'short'
  host?: 'cc' | 'codex'
  workflow?: 'free' | 'assist' | 'strict'
  book?: { title?: string; genre?: string; volume_size?: number; target_words?: number; chapter_target_words?: number; [k: string]: unknown }
  budget?: { calls_per_chapter?: number; [k: string]: unknown }
  style?: { injection?: 'light' | 'heavy'; [k: string]: unknown }
  auto?: { confirm_outline?: boolean; batch_size?: number; relation_auto_mine?: boolean; relation_mine_threshold?: number; [k: string]: unknown }
  /** 快照保留策略（单章版本回滚）；缺省 = 后端默认 14 天 / 30 个 */
  snapshots?: { max_days?: number; max_count?: number }
  rag?: { enabled?: boolean; endpoint?: string; model?: string; [k: string]: unknown }
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

// POST /api/books/:name/rename { name } → 全量改名（磁盘目录 + books.jsonl 登记 + active 指针 +
// book.yaml title 一起同步）。renamed=false = 同名 no-op（仅 title 回正）；true = 目录已搬家，
// 前端须把当前书切换到新名（res.name），否则旧名 URL 全部失效。
export interface RenameBookResult {
  ok: true
  renamed: boolean
  name: string
  path: string
}
export async function renameBook(name: string, newName: string): Promise<RenameBookResult> {
  return apiJson<RenameBookResult>(`/api/books/${encodeURIComponent(name)}/rename`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: newName }),
  })
}
