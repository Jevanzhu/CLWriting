/**
 * Web API 契约 ↔ 服务端权威类型的编译期对齐探针（七个前端 API 域）。
 *
 * 纪律同 documents.conformance.ts：本文件只被根 tsc 编译（web-next 的 tsconfig 只 include
 * web-next/src，本文件无人 import），只放类型断言、不写运行时语句。漂移（服务端加/删字段、
 * 改字段类型或判别值）在此编译期报错，契约与前端类型同步刷新前过不了 `npm run typecheck`。
 */
import type {
  CheckItem as ServerCheckItem,
  CheckLevel as ServerCheckLevel,
  CheckReport as ServerCheckReport,
  CheckSectionResult as ServerCheckSection,
} from '../../check/types.js'
import type { SampleCandidate as ServerSampleCandidate, QuoteCandidate as ServerQuoteCandidate } from '../../learn/index.js'
import type { DiffLine as ServerDiffLine } from '../../process/rewrite-prompt.js'
import type {
  ForeshadowEntry as ServerForeshadowEntry,
  ForeshadowHit as ServerForeshadowHit,
  ForeshadowTrail as ServerForeshadowTrail,
} from '../../document/foreshadow.js'
import type {
  EntryKind as ServerEntryKind,
  EntrySource as ServerEntrySource,
  StyleEntry as ServerStyleEntry,
} from '../../format/types.js'
import type { StyleCandidate as ServerStyleCandidate } from '../../format/style-candidate.js'
import type { StyleTrend as ServerStyleTrend } from '../../metrics/style.js'
import type {
  NormalizedReviewResult as ServerNormalizedReviewResult,
  ReviewIssue as ServerReviewIssue,
  ReviewLens as ServerReviewLens,
  ReviewMeta as ServerReviewMeta,
  ReviewSeverity as ServerReviewSeverity,
  ReviewCategory as ServerReviewCategory,
  ReviewTier as ServerReviewTier,
} from '../../review/contract.js'
import type { CollectedReview as ServerCollectedReview } from '../../review/run.js'
import type {
  CheckItem,
  CheckLevel,
  CheckReport,
  CheckSection,
  CheckResult,
} from './check.js'
import type { QuoteCandidate, SampleCandidate } from './learn.js'
import type { DiffLine } from './rewrite.js'
import type { Foreshadow, ForeshadowHit, ForeshadowTrail } from './foreshadows.js'
import type { EntryKind, EntrySource, StyleCandidate, StyleEntry, StyleTrend } from './style.js'
import type {
  CollectedReview,
  NormalizedReviewResult,
  ReviewCategory,
  ReviewIssue,
  ReviewLens,
  ReviewMeta,
  ReviewSeverity,
  ReviewTier,
} from './review.js'

/** 逐字段等价：键集相等（抓新增/删除字段，含可选字段）+ 双向可赋值（抓类型/判别值变化）。 */
type SameKeys<A, B> = [keyof A] extends [keyof B] ? ([keyof B] extends [keyof A] ? true : false) : false
type SameShape<A, B> =
  SameKeys<A, B> extends true ? ([A] extends [B] ? ([B] extends [A] ? true : false) : false) : false
type SameUnion<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false
type Assert<T extends true> = T

// ── check ──
export type _CheckLevel = Assert<SameUnion<CheckLevel, ServerCheckLevel>>
export type _CheckItem = Assert<SameShape<CheckItem, ServerCheckItem>>
export type _CheckSection = Assert<SameShape<CheckSection, ServerCheckSection>>
export type _CheckReport = Assert<SameShape<CheckReport, ServerCheckReport>>

// ── learn ──
export type _SampleCandidate = Assert<SameShape<SampleCandidate, ServerSampleCandidate>>
export type _QuoteCandidate = Assert<SameShape<QuoteCandidate, ServerQuoteCandidate>>

// ── rewrite ──
export type _DiffLine = Assert<SameShape<DiffLine, ServerDiffLine>>

// ── foreshadows（回包 = 条目 + 足迹）──
export type _ForeshadowHit = Assert<SameShape<ForeshadowHit, ServerForeshadowHit>>
export type _ForeshadowTrail = Assert<SameShape<ForeshadowTrail, ServerForeshadowTrail>>
export type _Foreshadow = Assert<
  SameShape<Foreshadow, ServerForeshadowEntry & { 足迹: ServerForeshadowTrail | null }>
>

// ── style ──
export type _EntryKind = Assert<SameUnion<EntryKind, ServerEntryKind>>
export type _EntrySource = Assert<SameUnion<EntrySource, ServerEntrySource>>
export type _StyleEntry = Assert<SameShape<StyleEntry, ServerStyleEntry>>
export type _StyleCandidate = Assert<SameShape<StyleCandidate, ServerStyleCandidate>>
// StyleTrend 是 UI 投影：服务端完整类型必须可赋给契约（服务端删字段/改类型即红）。
export type _StyleTrendProjection = Assert<[ServerStyleTrend] extends [StyleTrend] ? true : false>

// ── review ──
export type _ReviewLens = Assert<SameUnion<ReviewLens, ServerReviewLens>>
export type _ReviewSeverity = Assert<SameUnion<ReviewSeverity, ServerReviewSeverity>>
export type _ReviewCategory = Assert<SameUnion<ReviewCategory, ServerReviewCategory>>
export type _ReviewTier = Assert<SameUnion<ReviewTier, ServerReviewTier>>
export type _ReviewIssue = Assert<SameShape<ReviewIssue, ServerReviewIssue>>
export type _NormalizedReviewResult = Assert<SameShape<NormalizedReviewResult, ServerNormalizedReviewResult>>
export type _ReviewMeta = Assert<SameShape<ReviewMeta, ServerReviewMeta>>
export type _CollectedReview = Assert<SameShape<CollectedReview, ServerCollectedReview>>

// 端点回包字面量由服务端 `satisfies` 接入多余属性检查；此处只钉场上的 CheckResult 形状。
export type _CheckResultShape = CheckResult
