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
  [k: string]: unknown
}
export async function getConfig(name: string): Promise<BookConfig> {
  const r = await apiJson<{ config: BookConfig }>(
    `/api/books/${encodeURIComponent(name)}/config`,
  )
  return r.config
}

// POST /revert {chapter} → 回滚到第 N 章（版本回滚，内容进 git 备份 ref 可找回）。
export async function revert(name: string, chapter: number): Promise<void> {
  await apiJson<{ ok: true; message?: string }>(
    `/api/books/${encodeURIComponent(name)}/revert`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chapter }),
    },
  )
}

// GET /words-diary → {date, baseline}（§5.4 今日基线；baseline=null 表示今日未记）。
export async function getWordsDiary(
  name: string,
): Promise<{ date: string; baseline: number | null }> {
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
