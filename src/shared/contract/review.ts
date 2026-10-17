/**
 * 三审回包契约（前端 api/review.ts 与服务端 review 端点共用）。
 *
 * 服务端权威类型 = src/review/contract.ts 与 src/review/run.ts 的 CollectedReview。
 * 本文件为跨端同源声明，不得 import 服务端模块；漂移由 review.conformance.ts 钉住。
 */

export type ReviewLens =
  'reader' | 'editor' | 'continuity' | 'disclosure' | 'plot_causality' | 'hook' | 'emotion_peak' | 'payoff'

export type ReviewSeverity = 'S1' | 'S2' | 'S3' | 'S4'

export type ReviewCategory =
  | 'high_point'
  | 'reader_pull'
  | 'pacing'
  | 'ooc'
  | 'logic'
  | 'consistency'
  | 'continuity'
  | 'setting'
  | 'timeline'
  | 'strand'
  | 'ledger'
  | 'safety'
  | 'disclosure'
  | 'causality'
  | 'hook'
  | 'emotion_peak'
  | 'reversal'
  | 'payoff'

export type ReviewTier = 'full' | 'sequential' | 'combined'

export interface ReviewIssue {
  lens: ReviewLens
  severity: ReviewSeverity
  category: ReviewCategory
  location: string
  evidence: string[]
  issue: string
  fix: string
  blocking?: boolean
}

export interface NormalizedReviewResult {
  blockers: ReviewIssue[]
  warnings: ReviewIssue[]
  invalid_issues: ReviewIssue[]
  passed: boolean
}

export interface ReviewMeta {
  requested_tier: ReviewTier
  effective_tier: ReviewTier
  fallback: string
  lenses_run: ReviewLens[]
  ledger_check: '已跑' | '跳过'
  downgrade_reason?: string
}

/** 审稿单采集结果（服务端 collectReviewIssues 原样透传）。 */
export interface CollectedReview {
  ok: boolean
  collected_lenses: ReviewLens[]
  missing_lenses: ReviewLens[]
  bad_entries: { path: string; reason: string }[]
  raw_issues: ReviewIssue[]
  normalized: NormalizedReviewResult
  meta: ReviewMeta
  tier: ReviewTier
  requested_tier: ReviewTier
  fallback: string
  chapter: number
  lenses_run: ReviewLens[]
}

/** POST /documents/:docId/review 回包。 */
export interface ReviewResult {
  ok: true
  /** 端点回传的视角名（运行时字符串数组；视角全集见 CollectedReview.lenses_run）。 */
  lenses: string[]
  collected: CollectedReview
  /** 知识层注入报告（前端不消费；服务端回包附带）。 */
  knowledge?: unknown
}

export interface ReviewVerdict {
  approved: boolean
  at: string
}

export interface ReviewEnvelope {
  generatedAt: string
  model: string
  sourceHash: string
  payload: { collected: CollectedReview; lenses: string[]; verdict?: ReviewVerdict; incomplete?: true }
}

/** GET /documents/:docId/review/envelope 回包。 */
export interface ReviewEnvelopeResult {
  ok: true
  envelope: ReviewEnvelope
  stale: boolean
}
