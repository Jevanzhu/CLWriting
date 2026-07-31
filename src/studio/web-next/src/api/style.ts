import { apiJson } from './client'

// 文风系统 API（文风系统重整 S7）：镜像后端 api/style.ts + health/style 契约。
// 条目库/候选箱/收割/定标全零 AI；AI 语义分析走 api/analysis.ts
//（源3 由后端 analyze-style 完成时自动落候选，前端无需另调）。

export type EntryKindFE = '样章' | '手法' | '反例' | '禁词'
export type EntrySourceFE = '作者标注' | '改稿行为' | '收割' | '题材范文' | '导入'

/** 条目（镜像 format/style-entry.ts StyleEntry；_path 为书内相对路径） */
export interface StyleEntryFE {
  类型: EntryKindFE
  场景: string
  来源: EntrySourceFE
  说明?: string
  出处?: string
  标签?: string[]
  正文: string
  _path: string
}

/** 候选（镜像 format/style-candidate.ts StyleCandidate；状态经服务端 30 天过期呈现） */
export interface StyleCandidateFE {
  类型: EntryKindFE
  场景: string
  来源: EntrySourceFE
  说明?: string
  标签?: string[]
  正文: string
  状态: '待确认' | '已忽略'
  创建: string
  章号?: number
  相似度?: number
  频次?: number
  AI版?: string
  _path: string
}

/** 首读自动迁移结果（迁移发生时非 null，供 toast） */
export interface StyleMigrationFE {
  migrated: number
  details: string[]
}

/** 铁律机检阈值（镜像 check/count.ts IronRules，禁词不在此——在条目库） */
export interface StyleRulesFE {
  maxSentenceLen?: number
  maxAdjStack?: number
  maxDialogueTagRatio?: number
  maxParallelStreak?: number
  avoidSummaryEnding?: boolean
}

export interface StyleBaselineSummaryFE {
  frozenAt: string
  frozenFrom: string
  scenes: string[]
}

/** 定标数据（GET /style/config） */
export interface StyleConfigFE {
  rules: StyleRulesFE
  baseline: StyleBaselineSummaryFE | null
  injection: 'light' | 'heavy'
}

/** 机检趋势（镜像 metrics/style.ts StyleTrend，取 UI 展示字段） */
export interface StyleTrendFE {
  kind: 'long' | 'short'
  count: number
  dialogueTagSeries: number[]
  varianceSeries: number[]
  repeatSeries: number[]
  overlongChapters: number[]
  adjStackChapters: number[]
  summaryEndingChapters: number[]
  drifts: { metric: string; message: string }[]
  baseline: { frozenAt: string } | null
}

function base(name: string): string {
  return `/api/books/${encodeURIComponent(name)}/style`
}

export async function listStyleEntries(
  name: string,
): Promise<{ entries: StyleEntryFE[]; errors: unknown[]; migration: StyleMigrationFE | null }> {
  return apiJson(`${base(name)}/entries`)
}

export async function addStyleEntry(
  name: string,
  entry: { 类型: EntryKindFE; 正文: string; 场景?: string; 说明?: string; 出处?: string; 标签?: string[] },
): Promise<{ path: string }> {
  return apiJson(`${base(name)}/entries`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(entry),
  })
}

export async function deleteStyleEntry(name: string, path: string): Promise<void> {
  await apiJson(`${base(name)}/entries`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path }),
  })
}

export async function listStyleCandidates(
  name: string,
): Promise<{ candidates: StyleCandidateFE[]; errors: unknown[] }> {
  return apiJson(`${base(name)}/candidates`)
}

export async function confirmStyleCandidate(name: string, path: string): Promise<{ entryPath: string }> {
  return apiJson(`${base(name)}/candidates/confirm`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path }),
  })
}

export async function ignoreStyleCandidate(name: string, path: string): Promise<void> {
  await apiJson(`${base(name)}/candidates/ignore`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path }),
  })
}

/** 收割（零 AI）：源1 改稿轨迹比对 + 源2 机检漂移映射 → 候选箱 */
export async function runStyleHarvest(name: string): Promise<{ created: number; skipped: number }> {
  return apiJson(`${base(name)}/harvest`, { method: 'POST' })
}

export async function getStyleConfig(name: string): Promise<StyleConfigFE> {
  return apiJson(`${base(name)}/config`)
}

export async function freezeStyleBaseline(name: string): Promise<{ baseline: StyleBaselineSummaryFE }> {
  return apiJson(`${base(name)}/baseline/freeze`, { method: 'POST' })
}

/** 机检重扫（零 AI，按需全量重算；复用体检报告同源端点） */
export async function getStyleTrend(name: string): Promise<StyleTrendFE> {
  return apiJson(`/api/books/${encodeURIComponent(name)}/health/style`)
}
