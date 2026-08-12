import { apiJson } from './client'

// 工作台 HTTP 端点（细案 §2.2）。AI 类（spawn/outline）阻塞数十秒，调用方防重复提交。

// GET /state → 当前态机状态（状态卡）
export interface BookState {
  state: number
  stateName: string
  humanMsg: string
  action: string
  nextChapter?: number
  kind?: string
  /** 态 4 续写断点：pre-commit=续写；post-commit-residue=重新定位 */
  resumePoint?: 'pre-commit' | 'post-commit-residue'
}
export async function getState(name: string): Promise<BookState> {
  return apiJson(`/api/books/${encodeURIComponent(name)}/state`)
}

// POST /spawn {role?, prompt?} —— 起角色生成（AI 阻塞）
export async function spawnRole(
  name: string,
  body: { role?: string; prompt?: string },
): Promise<void> {
  await apiJson(`/api/books/${encodeURIComponent(name)}/spawn`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }, 120_000) // 角色生成超时 2 分钟
}

// POST /interrupt —— 中断当前生成（同时停自愈编排循环）
export async function interrupt(name: string): Promise<void> {
  await apiJson(`/api/books/${encodeURIComponent(name)}/interrupt`, { method: 'POST' })
}

// POST /auto-write {chapter, batchSize?} —— 全自动写章：写稿→机检→红则自动重写→全绿或触顶交作者。
// fire-and-forget：立即返回，进度经 SSE 的 self_heal_* 事件回流。409 = 本书已在跑。
// P2-3：batchSize>1 时后端连写多章（中途红项触顶停当前章，不再续写后续）。
export async function autoWrite(
  name: string,
  chapter: number,
  batchSize = 1,
): Promise<{ ok: boolean; chapter: number; batchSize?: number; chapters?: number[] }> {
  return apiJson(
    `/api/books/${encodeURIComponent(name)}/auto-write`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chapter, ...(batchSize > 1 ? { batchSize } : {}) }),
    },
    30_000, // 后端应秒级确认并开始 SSE 回流；挂起则超时提示
  )
}

// POST /draft-save {chapter, content} → {ok, path, words, docId, snapshotted}
// docId：清单真 ID 或 legacyId 派生（与树一致，可直接 openTab）；snapshotted：覆写前留了快照（M1）
export interface DraftSaveResult {
  ok: boolean
  path: string
  words: number
  docId: string
  snapshotted: boolean
}
export async function saveDraft(name: string, chapter: number, content: string): Promise<DraftSaveResult> {
  return apiJson(`/api/books/${encodeURIComponent(name)}/draft-save`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chapter, content }),
  })
}

// GET /draft-prompt?chapter= → {prompt}
export async function getDraftPrompt(name: string, chapter: number): Promise<{ prompt: string }> {
  return apiJson(`/api/books/${encodeURIComponent(name)}/draft-prompt?chapter=${chapter}`)
}

// POST /outline {chapter} —— 大纲生成（AI 阻塞，多源合成）
export async function generateOutline(name: string, chapter: number): Promise<void> {
  await apiJson(`/api/books/${encodeURIComponent(name)}/outline`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chapter }),
  }, 300_000) // 大纲多源合成超时 5 分钟
}
