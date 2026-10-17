/**
 * 文风回包契约（前端 api/style.ts 与服务端 style 端点共用）。
 *
 * 服务端权威类型 = format/types.ts（StyleEntry / EntryKind / EntrySource）、
 * format/style-candidate.ts（StyleCandidate）、format/iron-rules.ts（IronRules）、
 * metrics/style.ts（StyleTrend）。本文件为跨端同源声明，不得 import 服务端模块；
 * 漂移由 style.conformance.ts 钉住。
 */

export type EntryKind = '样章' | '手法' | '反例' | '禁词'
export type EntrySource = '作者标注' | '改稿行为' | '收割' | '题材范文' | '导入'

export interface StyleEntry {
  类型: EntryKind
  场景: string
  来源: EntrySource
  说明?: string
  出处?: string
  标签?: string[]
  正文: string
  证据?: { 章号: number; AI版: string; 作者版: string }
  _raw?: Record<string, string | string[]>
  _path?: string
}

export interface StyleCandidate {
  类型: EntryKind
  场景: string
  来源: EntrySource
  说明?: string
  标签?: string[]
  正文: string
  状态: '待确认' | '已忽略'
  创建: string
  章号?: number
  相似度?: number
  频次?: number
  AI版?: string
  _path?: string
}

/** 首读自动迁移结果（迁移发生时非 null，供 toast）。 */
export interface StyleMigration {
  migrated: number
  details: string[]
}

/** 铁律机检阈值（禁词不在 rules——在条目库）。 */
export interface IronRules {
  maxSentenceLen?: number
  maxAdjStack?: number
  maxDialogueTagRatio?: number
  maxParallelStreak?: number
  avoidSummaryEnding?: boolean
  bannedWords?: string[]
  unparsedBannedEntries?: string[]
}

export interface StyleBaselineSummary {
  frozenAt: string
  frozenFrom: string
  scenes: string[]
}

/** GET /style/config 回包（服务端另带 ok 字段，前端不消费）。 */
export interface StyleConfig {
  rules: IronRules
  baseline: StyleBaselineSummary | null
  injection: 'light' | 'heavy'
}

export interface StyleConfigResult extends StyleConfig {
  ok: true
}

export interface StyleBaselineResult {
  ok: true
  baseline: StyleBaselineSummary
}

/** GET /health/style 回包（UI 展示字段；服务端另带 samples 等明细）。 */
export interface StyleTrend {
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

/** GET /style/entries 回包。 */
export interface StyleEntriesResult {
  ok: true
  entries: StyleEntry[]
  errors: unknown[]
  migration: StyleMigration | null
}

/** GET /style/candidates 回包。 */
export interface StyleCandidatesResult {
  ok: true
  candidates: StyleCandidate[]
  errors: unknown[]
}
