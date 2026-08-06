import { apiJson } from './client'

/** 版本列表项（后端 VersionEntry）。 */
export interface SnapshotEntry {
  id: string
  /** 毫秒时间戳 */
  time: number
  origin: string
  reason: string
  words: number
  /** 永久保留标记（定稿里程碑，不被清理） */
  pinned: boolean
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

/** 版本统计（改动 10b）：全书快照占用 / 总数 / 定稿章节数 / 定稿版本数。 */
export interface VersionStats {
  snapshotBytes: number
  snapshotCount: number
  pinnedCount: number
  finalizedDocs: number
}

// GET /api/books/:name/version-stats → 版本历史 tab 统计
export async function getVersionStats(name: string): Promise<VersionStats> {
  const r = await apiJson<{ ok: true } & VersionStats>(
    `/api/books/${encodeURIComponent(name)}/version-stats`,
  )
  return {
    snapshotBytes: r.snapshotBytes,
    snapshotCount: r.snapshotCount,
    pinnedCount: r.pinnedCount,
    finalizedDocs: r.finalizedDocs,
  }
}
