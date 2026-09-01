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
  book?: { title?: string; genre?: string; volume_size?: number; target_words?: number; chapter_target_words?: number; [k: string]: unknown }
  budget?: { calls_per_chapter?: number; [k: string]: unknown }
  style?: { injection?: 'light' | 'heavy'; [k: string]: unknown }
  auto?: { confirm_outline?: boolean; batch_size?: number; relation_auto_mine?: boolean; relation_mine_threshold?: number; [k: string]: unknown }
  /** 快照保留策略（单章版本回滚）；缺省 = 后端默认 14 天 / 30 个 */
  snapshots?: { max_days?: number; max_count?: number }
  rag?: { enabled?: boolean; provider?: string; endpoint?: string; model?: string; [k: string]: unknown }
  /** 短篇集机检配置（题材预设阈值 + strict 严格模式） */
  short?: { strict?: boolean; word_min?: number; word_max?: number; body_part_threshold?: number; simile_threshold?: number; section_count?: number; opening_env_chars?: number; [k: string]: unknown }
  [k: string]: unknown
}
export async function getConfig(name: string): Promise<BookConfig> {
  const r = await apiJson<{ config: BookConfig }>(
    `/api/books/${encodeURIComponent(name)}/config`,
  )
  return r.config
}

// GET /config 的 revision 信封视图（R34D-25）：服务端随 GET 回传 book.yaml 内容指纹
// revision（sha256 前 4 字节 uint32，文件缺失为 0），供读改写调用方下次 PUT 带
// expectedRevision。只读调用方继续用 getConfig（返回型不变，零波及）。
export async function getConfigWithRevision(
  name: string,
): Promise<{ config: BookConfig; revision: number }> {
  return apiJson<{ config: BookConfig; revision: number }>(
    `/api/books/${encodeURIComponent(name)}/config`,
  )
}

// PUT /config {config} → 全量写回 book.yaml（须传完整 config，服务端整文件重写）。
// R34D-25（三十四轮）：expectedRevision 可选乐观锁（对齐 putGlobalPrefs 的 GG-P2-7 契约：
// 不传 = 直通，向后兼容；传入则随 body 上送，服务端失配回 409，经 apiJson 抛
// ApiError{status:409, code:REVISION_CONFLICT}——调用方以此拦截「双标签页后写者
// 静默覆盖先写者」）。服务端批已落地消费：GET 回传内容指纹 revision + PUT 比对
// 409（config.ts 同轮实修），SettingsModal 经 getConfigWithRevision 穿线端到端生效。
export async function putConfig(
  name: string,
  config: BookConfig,
  expectedRevision?: number,
): Promise<void> {
  await apiJson<{ ok: true }>(`/api/books/${encodeURIComponent(name)}/config`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ config, expectedRevision }),
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
// eventsMigrationFailed=true（kk-P1-3）：会话/事件库迁移失败（旧库原地完整保留在旧名 hash 下，
// 数据可找回但不再随新名可达）——改名成功与迁移失败可并存，UI 须出警告而非静默成功。
export interface RenameBookResult {
  ok: true
  renamed: boolean
  name: string
  path: string
  eventsMigrationFailed?: true
}
export async function renameBook(name: string, newName: string): Promise<RenameBookResult> {
  return apiJson<RenameBookResult>(`/api/books/${encodeURIComponent(name)}/rename`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: newName }),
  })
}

// ── RAG 接线（cc 批4 P1-8）──────────────────────────────────────────
// 建索引是长任务：POST build 后台跑完，前端轮询 GET status。
// 服务商化：endpoint/model/key 归应用级 RAG 服务商管（api/providers.ts），书只存 provider 引用 + enabled。
export interface RagStatus {
  running: boolean
  indexedChapters: number
  chunkCount: number
  model: string | null
  ragConfig: { enabled?: boolean; provider?: string; endpoint?: string; model?: string }
  /** 生效服务商名（旧版内联配置时为 null + legacy=true） */
  providerName: string | null
  /** true = 书还在用旧版内联 endpoint/model（未迁移到服务商引用） */
  legacy: boolean
  lastResult: { ok: boolean; chunkCount: number; chapterCount: number; error?: string } | null
}

export async function getRagStatus(name: string): Promise<RagStatus> {
  return apiJson<RagStatus>(`/api/books/${encodeURIComponent(name)}/rag/status`)
}

export async function triggerRagBuild(name: string): Promise<{ started: true }> {
  return apiJson<{ started: true }>(`/api/books/${encodeURIComponent(name)}/rag/build`, {
    method: 'POST',
  })
}
