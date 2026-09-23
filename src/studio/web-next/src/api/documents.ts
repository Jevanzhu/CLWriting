import { apiJson, API_DEFAULT_TIMEOUT_MS } from './client'

// GET /file?file=<path> → 完整载荷（路径寻址读全文，含 frontmatter；细案 §2.1）。
// E1（复审-0914-优化修复批）：同端点三包装（getContent / getContentPayload /
// getContentRevisioned 均打同一 GET /file）收敛为单读口——调用方按需解构取字段。
// getContent（只取 content）与 getContentRevisioned（content+revision 壳）均已随
// 消费方改造删除（StyleBaselineCard 为最后一个调用点，复审-0914-优化修复批收口）。
// 重评-0912-4 P1-1（2026-09-12 全量重评修复批）：GET /file 带编码探测的完整载荷——
// 服务端对非 UTF-8 存量文件（GBK/Big5 导入旧稿）回 encodingSuspect/encodingHint，
// doOpen 打开时据此 toast 告警（作者在乱码上编辑保存会被 R66-1 防线 400 拒绝）。
export interface FileContentPayload {
  content: string
  revision?: string
  encodingSuspect?: boolean
  encodingHint?: string
}
export async function getContentPayload(name: string, path: string): Promise<FileContentPayload> {
  return apiJson<FileContentPayload>(
    `/api/books/${encodeURIComponent(name)}/file?file=${encodeURIComponent(path)}`,
  )
}

// PUT /file?file=<path> ← {content}（路径寻址写全文；文件须已存在）。
// 用于无 docId 的资产文件（如 文风/文风铁律.md，撤出编辑树后在 SettingsModal 编辑）。
// M-3：expectedRevision 可选——传入时服务端做乐观锁，基线不符抛 ApiError{code:'REVISION_CONFLICT'}；
// 缺省保持旧「后写为准」语义（存量调用方零改动）。
export async function putContent(
  name: string,
  path: string,
  content: string,
  expectedRevision?: string,
): Promise<{ revision: string }> {
  return apiJson<{ ok: true; revision: string }>(
    `/api/books/${encodeURIComponent(name)}/file?file=${encodeURIComponent(path)}`,
    {
      method: 'PUT',
      json: {
        content,
        ...(expectedRevision !== undefined ? { expectedRevision } : {}),
      },
    },
  )
}

// PUT /documents/:docId/content —— 乐观锁保存（细案 §2.1 保存协议）。
// 成功 → {ok,revision,superseded}；409 冲突由 apiJson 抛 ApiError{code:'REVISION_CONFLICT'}，调用方 catch。
export interface SaveOk {
  ok: true
  revision: `sha256:${string}`
  superseded?: boolean
  /** RC 源码重审 A-5（Opus-5.5 轮）：服务端保存前留底失败（工作区/.版本 不可写）但正文
   *  已落盘——留底是兜底不是闸（fail-open），保存成功；本旗仅降级时带出，doc store 据此
   *  每文档提示一次「版本历史有缺口」。 */
  snapshotDegraded?: boolean
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
      json: body,
    },
    API_DEFAULT_TIMEOUT_MS, // 本地磁盘写应秒级；超时防 saving 永不清除（原裸值 30_000，A5 收敛）
  )
}

// --- 树 CRUD（细案 §2.1）---

// POST /documents（新建；建卷即建首章靠 relPath 含 <卷>/<首章>.md）。
interface CreateOk {
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
    json: body,
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
      json: { relPath },
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
      json: { op: 'rename', newName },
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
      json: { op: 'move', toDir },
    },
  )
}

// PATCH /documents/:docId op=meta（块2.2：更新章节/短篇元数据 标题/章号；写 fm + 路径同步 rename）。
export async function updateChapterMetaDoc(
  name: string,
  docId: string,
  meta: { 标题?: string; 章号?: number },
): Promise<{ ok: true }> {
  return apiJson<{ ok: true }>(
    `/api/books/${encodeURIComponent(name)}/documents/${encodeURIComponent(docId)}`,
    {
      method: 'PATCH',
      json: { op: 'meta', ...meta },
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
      json: { op: 'fm', meta },
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

// POST /documents/:docId/finalize —— 定稿确认（revision → final，git commit 锁定版本）。
interface FinalizeOk {
  ok: true
  status: 'final'
  skipped: boolean
}
export async function finalizeDoc(name: string, docId: string): Promise<FinalizeOk> {
  return apiJson<FinalizeOk>(
    `/api/books/${encodeURIComponent(name)}/documents/${encodeURIComponent(docId)}/finalize`,
    { method: 'POST' },
  )
}

// POST /documents/batch-finalize —— 批量定稿（P2-PROD-2）。
interface BatchFinalizeItem {
  docId: string
  ok: boolean
  status?: 'final'
  skipped?: boolean
  error?: string
}
interface BatchFinalizeOk {
  ok: true
  results: BatchFinalizeItem[]
}
export async function batchFinalizeDocs(name: string, docIds: string[]): Promise<BatchFinalizeOk> {
  return apiJson<BatchFinalizeOk>(
    `/api/books/${encodeURIComponent(name)}/documents/batch-finalize`,
    {
      method: 'POST',
      json: { docIds },
    },
    120_000, // R33-77（三十三轮）：慢档对齐 clearAudit——批量定稿逐章 git 提交可达数秒/章，30s 默认档必假超时（服务端继续成功、前端报超时不刷树）
  )
}

// --- 章节结构操作（阶段 24 S3+S4：合并 / 拆分 / 撤销合并）---

/** 合并干跑视图（确认弹窗数据源；服务端 structure.ts MergePlanView 同形裁剪——路径
 *  字段前端不消费，略）。 */
export interface MergePlanView {
  op: 'merge'
  targetDocId: string
  sourceDocId: string
  targetChapterNo: number
  sourceChapterNo: number
  targetTitle: string
  sourceTitle: string
  /** 任一方非 UTF-8（GBK 存量）——apply 将 400 拒绝，前端干跑后即拦 */
  encodingSuspect: boolean
  sourceWords: number
  sourcePreview: string
  /** 折叠后目标章 fm 并入 数组（写侧单跳化） */
  mergedInto: number[]
  /** 源章履历引文对拼接正文的命中预演（false 项合并后将产 lead-evidence-miss 红） */
  leadPreviews: Array<{ leadId: string; 动词: string; 证据: string; willMatch: boolean }>
  /** 源章 RAG 向量块清除预估 */
  ragChunksToClear: number
  planHash: string
}

/** 拆分干跑视图（拆分弹窗数据源；服务端 SplitPlanView 同形裁剪）。 */
export interface SplitPlanView {
  op: 'split'
  docId: string
  chapterNo: number
  title: string
  /** 新章号 = 全书 max+1 再跳已定稿章号（篇号永不复用） */
  newChapterNo: number
  order: number
  headWords: number
  tailWords: number
  tailPreview: string
  /** 原章 fm 已发布 → 提示「平台连载无插入机制」，不硬拦 */
  publishedWarning: boolean
  planHash: string
}

export interface MergeApplyOk {
  ok: true
  targetDocId: string
  sourceDocId: string
  targetChapterNo: number
  sourceChapterNo: number
  mergedInto: number[]
  /** = 源 docId（TrashEntry.id 即原 docId） */
  trashEntryId: string
  rollbackSnapshotId?: string
  planHash: string
}
export interface SplitApplyOk {
  ok: true
  docId: string
  newDocId: string
  originChapterNo: number
  newChapterNo: number
  order: number
  title: string
}
export interface MergeUndoOk {
  ok: true
  targetDocId: string
  sourceDocId: string
  sourceChapterNo: number
  trashEntryId: string
  planHash: string
}

// POST /documents/:docId/structure-plan —— 干跑预览（不占结构闸；合并 body 带
// sourceDocId（:docId = 目标章），拆分带 cursorOffset（全文坐标，含 fm））。
// 失败（BUSY/NOT_FOUND/BAD_INPUT…）由 apiJson 抛 ApiError，调用方 catch。
export async function structurePlan(
  name: string,
  docId: string,
  body: { op: 'merge'; sourceDocId: string } | { op: 'split'; cursorOffset: number },
): Promise<{ plan: MergePlanView | SplitPlanView }> {
  return apiJson<{ ok: true; plan: MergePlanView | SplitPlanView }>(
    `/api/books/${encodeURIComponent(name)}/documents/${encodeURIComponent(docId)}/structure-plan`,
    { method: 'POST', json: body },
  )
}

// POST /documents/:docId/structure-apply —— 携干跑指纹执行（服务端锁前重算比对，
// 失配 409 PLAN_STALE）。
export async function structureApply(
  name: string,
  docId: string,
  body:
    | { op: 'merge'; sourceDocId: string; planHash: string }
    | { op: 'split'; title: string; cursorOffset: number; planHash: string },
): Promise<MergeApplyOk | SplitApplyOk> {
  return apiJson<MergeApplyOk | SplitApplyOk>(
    `/api/books/${encodeURIComponent(name)}/documents/${encodeURIComponent(docId)}/structure-apply`,
    { method: 'POST', json: body },
    120_000, // 慢档对齐 batchFinalize——per-book 串行链排队 + 双章读写留底 + RAG 清理，30s 默认档在链积压时假超时（服务端继续成功、前端报超时不刷树）
  )
}

// POST /documents/:docId/merge-undo —— 撤销目标章最近一次合并（服务端三级定位：
// hints → 事件扫描 → 降级推演；前端无提示时恒发 {}）。
export async function structureMergeUndo(
  name: string,
  docId: string,
  hints: {
    sourceDocId?: string
    sourceChapterNo?: number
    trashEntryId?: string
    rollbackSnapshotId?: string
    planHash?: string
  } = {},
): Promise<MergeUndoOk> {
  return apiJson<MergeUndoOk>(
    `/api/books/${encodeURIComponent(name)}/documents/${encodeURIComponent(docId)}/merge-undo`,
    { method: 'POST', json: hints },
    120_000, // 同 structureApply——版本回滚 + 回收站还原 + 事件落账串行链
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
