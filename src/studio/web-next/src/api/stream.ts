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
  /** 连写暂停元状态（M6 #34 / kk-P1-4）：上次批量连写中途停（escalate/failed/aborted）
   *  且此后未再开批 → 提示从哪章续起；重新开批服务端即清 */
  batchPause?: { atChapter: number; reason: string; detail: string }
  /**
   * R0912-FE-P2-3（2026-09-11 重评-0911b 修复批）：态 1 崩溃 pending 的 opId 清单透出位
   * （对应 crashedWrite 体检项 files 字段，journal findUnsettled 的未结算 save pending）。
   * 服务端 /state payload 组装处（studio/server/api/state.ts）本批尚未透出该字段——
   * 前端先行接线（api 封装 + WbStateCard 忽略按钮），字段缺省/空数组时按钮不渲染，
   * 服务端补透出后即生效。opId 即 POST /journal/:opId/acknowledge 的路径参数。
   */
  crashedPendingOpIds?: string[]
}
export async function getState(name: string): Promise<BookState> {
  return apiJson(`/api/books/${encodeURIComponent(name)}/state`)
}

// POST /spawn {role?, prompt?, files?} —— 起角色生成（AI 阻塞）。
// files：GET /draft-prompt 回传的注入源清单（Q-5 溯源——服务端登记进 promptMeta.files）
export async function spawnRole(
  name: string,
  body: { role?: string; prompt?: string; files?: string[] },
): Promise<void> {
  await apiJson(`/api/books/${encodeURIComponent(name)}/spawn`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }, 120_000) // 角色生成超时 2 分钟
}

// POST /interrupt —— 中断当前生成（同时停自愈编排循环）
export async function interrupt(name: string): Promise<void> {
  await apiJson(`/api/books/${encodeURIComponent(name)}/interrupt`, { method: 'POST' }, 15_000)
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

// POST /journal/:opId/acknowledge → {ok, acknowledged}。R0912-1b（重评-0911c 服务端批
// 落端点，本批前端接线）：崩溃 save pending 的人工确认通道——对该 pending appendAborted，
// 使其不再报 crashedWrite「可能丢字」。幂等：opId 已 settled/不存在/重复确认 →
// acknowledged:false（确认动作可安全重复点击）；命中 pending → true。
export async function acknowledgeJournalPending(
  name: string,
  opId: string,
): Promise<{ ok: true; acknowledged: boolean }> {
  return apiJson<{ ok: true; acknowledged: boolean }>(
    `/api/books/${encodeURIComponent(name)}/journal/${encodeURIComponent(opId)}/acknowledge`,
    { method: 'POST' },
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

// GET /draft-prompt?chapter= → {prompt, files}（files = 注入源清单，Q-5 随 spawn 回传）
export async function getDraftPrompt(name: string, chapter: number): Promise<{ prompt: string; files?: string[] }> {
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

// W-P1-3 右端：POST /lead-updates {chapter} —— 生成账本推进草稿（AI 草拟，作者定稿时确认回写）
export async function generateLeadUpdates(name: string, chapter: number): Promise<{ ok: boolean; count: number }> {
  return apiJson(`/api/books/${encodeURIComponent(name)}/lead-updates`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chapter }),
  }, 300_000)
}
