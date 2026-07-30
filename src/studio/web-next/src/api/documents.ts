import { apiJson } from './client'

// GET /file?file=<path> → {content}（路径寻址读全文，含 frontmatter；细案 §2.1）。
export async function getContent(name: string, path: string): Promise<string> {
  const data = await apiJson<{ content: string }>(
    `/api/books/${encodeURIComponent(name)}/file?file=${encodeURIComponent(path)}`,
  )
  return data.content
}

// PUT /documents/:docId/content —— 乐观锁保存（细案 §2.1 保存协议）。
// 成功 → {ok,revision,superseded}；409 冲突由 apiJson 抛 ApiError{code:'REVISION_CONFLICT'}，调用方 catch。
export interface SaveOk {
  ok: true
  revision: `sha256:${string}`
  superseded?: boolean
}

export async function saveContent(
  name: string,
  docId: string,
  body: {
    content: string
    expectedRevision: `sha256:${string}` | null
    operationId: string
    origin?: 'manual' | 'autosave'
  },
): Promise<SaveOk> {
  return apiJson<SaveOk>(
    `/api/books/${encodeURIComponent(name)}/documents/${encodeURIComponent(docId)}/content`,
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
  )
}

// --- 树 CRUD（细案 §2.1）---

// POST /documents（新建；建卷即建首章靠 relPath 含 <卷>/<首章>.md）。
export interface CreateOk {
  ok: true
  docId: string
  path: string
  revision: `sha256:${string}`
}
export async function createDoc(
  name: string,
  body: { relPath: string; content?: string },
): Promise<CreateOk> {
  return apiJson<CreateOk>(`/api/books/${encodeURIComponent(name)}/documents`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

// POST /documents/:docId/copy（E3.3：复制源内容到新 relPath；章号前端算，标题加「副本」）。
// 返回同 createDoc（新 docId + path + revision）；源未登记 legacy → 404，前端提示。
export async function copyDoc(
  name: string,
  docId: string,
  relPath: string,
): Promise<CreateOk> {
  return apiJson<CreateOk>(
    `/api/books/${encodeURIComponent(name)}/documents/${encodeURIComponent(docId)}/copy`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ relPath }),
    },
  )
}

// PATCH /documents/:docId（rename / move；legacy:docId 会 404，前端提示）。
export async function renameDoc(
  name: string,
  docId: string,
  newName: string,
): Promise<{ ok: true }> {
  return apiJson<{ ok: true }>(
    `/api/books/${encodeURIComponent(name)}/documents/${encodeURIComponent(docId)}`,
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ op: 'rename', newName }),
    },
  )
}
export async function moveDoc(
  name: string,
  docId: string,
  toDir: string,
): Promise<{ ok: true }> {
  return apiJson<{ ok: true }>(
    `/api/books/${encodeURIComponent(name)}/documents/${encodeURIComponent(docId)}`,
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ op: 'move', toDir }),
    },
  )
}

// PATCH /documents/:docId op=meta（块2.2：更新章节/短篇元数据 标题/章号|篇号；写 fm + 路径同步 rename）。
export async function updateChapterMetaDoc(
  name: string,
  docId: string,
  meta: { 标题?: string; 章号?: number; 篇号?: number },
): Promise<{ ok: true }> {
  return apiJson<{ ok: true }>(
    `/api/books/${encodeURIComponent(name)}/documents/${encodeURIComponent(docId)}`,
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ op: 'meta', ...meta }),
    },
  )
}

// PATCH /documents/:docId op=fm（块3.1：通用 fm 字段更新，卷纲/总纲用；不联动文件名）。
export async function updateDocMeta(
  name: string,
  docId: string,
  meta: Record<string, unknown>,
): Promise<{ ok: true }> {
  return apiJson<{ ok: true }>(
    `/api/books/${encodeURIComponent(name)}/documents/${encodeURIComponent(docId)}`,
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ op: 'fm', meta }),
    },
  )
}

// DELETE /documents/:docId（软删 → 回收站）。
export async function deleteDoc(name: string, docId: string): Promise<{ ok: true }> {
  return apiJson<{ ok: true }>(
    `/api/books/${encodeURIComponent(name)}/documents/${encodeURIComponent(docId)}`,
    { method: 'DELETE' },
  )
}

// --- 回收站 ---
export interface TrashEntry {
  id: string
  path: string
  originalPath?: string
  deletedAt?: string
}
export async function listTrash(name: string): Promise<TrashEntry[]> {
  const r = await apiJson<{ entries: TrashEntry[] }>(
    `/api/books/${encodeURIComponent(name)}/trash`,
  )
  return r.entries ?? []
}
export async function restoreTrash(name: string, id: string): Promise<{ ok: true }> {
  return apiJson<{ ok: true }>(
    `/api/books/${encodeURIComponent(name)}/trash/${encodeURIComponent(id)}/restore`,
    { method: 'POST' },
  )
}
export async function purgeTrash(name: string, id: string): Promise<{ ok: true }> {
  return apiJson<{ ok: true }>(
    `/api/books/${encodeURIComponent(name)}/trash/${encodeURIComponent(id)}`,
    { method: 'DELETE' },
  )
}
