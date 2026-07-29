import { apiJson } from './client'

/** 版本列表项（后端 SnapshotEntry）。 */
export interface SnapshotEntry {
  id: string
  /** 毫秒时间戳 */
  time: number
  origin: string
  reason: string
  words: number
}

// GET /documents/:docId/snapshots → 版本列表（新的在前）
export async function listSnapshots(name: string, docId: string): Promise<SnapshotEntry[]> {
  const r = await apiJson<{ entries: SnapshotEntry[] }>(
    `/api/books/${encodeURIComponent(name)}/documents/${encodeURIComponent(docId)}/snapshots`,
  )
  return r.entries
}

// GET /documents/:docId/snapshots/:id → 单个版本内容（预览）
export async function readSnapshot(name: string, docId: string, id: string): Promise<string> {
  const r = await apiJson<{ content: string }>(
    `/api/books/${encodeURIComponent(name)}/documents/${encodeURIComponent(docId)}/snapshots/${encodeURIComponent(id)}`,
  )
  return r.content
}

// POST /documents/:docId/snapshots/:id/restore → 恢复该版本（当前内容自动留底）
export async function restoreSnapshot(
  name: string,
  docId: string,
  id: string,
  expectedRevision: string,
): Promise<{ revision: string; content: string }> {
  return apiJson(
    `/api/books/${encodeURIComponent(name)}/documents/${encodeURIComponent(docId)}/snapshots/${encodeURIComponent(id)}/restore`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ expectedRevision }),
    },
  )
}
