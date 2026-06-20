/**
 * 采集一条定稿指标记录（指标方案 §3/§4）。
 *
 * 从工作区回收两类过程数据（定稿后无法重算）：
 * - 成本（调用次数 + 可选 token）：readAiCallBudget 读 .ai-calls.json（clear 前）
 * - 审查（tier/降级/问题数）：readReviewPacket + collectReviewIssues 读 三审/packet.json（零改 review 模块）
 *
 * 关键时序：必须在 clearWorkDir 之前调用——.ai-calls.json 和 三审/ 都在 clearWorkDir(commit.ts:228) 才删。
 * words 不在 doFinalize 入参，函数内 countWords(ctx.body) 现算。
 */

import { readAiCallBudget, type AiCallStep } from '../ai/calls.js'
import { readReviewPacket, collectReviewIssues } from '../review/run.js'
import { countWords } from '../format/chapters.js'
import type { BookConfig } from '../format/types.js'
import { appendMetric, resolveCallLimit, type CallBreakdown, type MetricRecord, type ReviewMetrics } from './ledger.js'

export interface CollectContext {
  kind: 'long' | 'short'
  num: number
  title: string
  body: string
  config: BookConfig
}

/** 采集结果：调用次数分解 + 可选 token 总和（全 null 仍 null，成本闭环 §2 D3） */
interface CollectedCalls {
  calls: CallBreakdown
  /** entries 里至少一条带 tokens 则求和；全部缺省 → null */
  tokens: number | null
}

/**
 * 组装一条成本/审查 MetricRecord。
 * 不写盘（append 由调用方决定）；任何子项缺失都诚实降级（calls 全 0 / review=null），不抛异常。
 */
export function collectMetrics(
  _bookRoot: string,
  workDir: string,
  ctx: CollectContext,
): MetricRecord {
  const collected = collectCalls(workDir, ctx.config)
  const review = collectReview(workDir)
  return {
    kind: ctx.kind,
    num: ctx.num,
    title: ctx.title,
    words: countWords(ctx.body),
    at: new Date().toISOString(),
    calls: collected.calls,
    tokens: collected.tokens, // 有则真、全无则 null（通道已通，本期宿主多拿不到 usage）
    review,
  }
}

/** 采集调用次数分解 + 可选 token 总和。.ai-calls.json 缺失（未调用 AI）→ 全 0、tokens null。 */
function collectCalls(workDir: string, config: BookConfig): CollectedCalls {
  const read = readAiCallBudget(workDir)
  if (!read.ok || read.record === null) {
    const limit = config.budget.calls_per_chapter
    return { calls: { outline: 0, draft: 0, review: 0, total: 0, limit }, tokens: null }
  }
  const record = read.record
  const byStep = new Map<AiCallStep, number>()
  let tokenSum = 0
  let anyTokens = false
  for (const entry of record.entries) {
    // review + review-combined 都归 review
    const bucket: AiCallStep = entry.step === 'review-combined' ? 'review' : entry.step
    byStep.set(bucket, (byStep.get(bucket) ?? 0) + entry.calls)
    if (entry.tokens !== undefined && Number.isFinite(entry.tokens)) {
      tokenSum += entry.tokens
      anyTokens = true
    }
  }
  return {
    calls: {
      outline: byStep.get('outline') ?? 0,
      draft: byStep.get('draft') ?? 0,
      review: byStep.get('review') ?? 0,
      total: record.used,
      limit: resolveCallLimit(config, record.limit_override),
    },
    // 至少一条 entry 带 tokens 才有值；全部缺省 → null（诚实反映「未采集」）
    tokens: anyTokens ? tokenSum : null,
  }
}

/**
 * 采集审查档位/降级/问题数。
 * 复用 review 模块的 readReviewPacket + collectReviewIssues（零改 review）。
 * 三审/ 或 packet.json 缺失 → null（短篇合审/未三审/旧工作区诚实降级）。
 * packet 存在但损坏/缺视角 → 同样记 null，但 console.warn 留痕（区分「本就没三审」
 * 与「本该满审但产物坏了」，后者不应被静默掩盖；同 markHealthCheckDone 容错风格）。
 */
function collectReview(workDir: string): ReviewMetrics | null {
  const packetRead = readReviewPacket(workDir)
  if (!packetRead.ok) return null // 本就没三审，正常降级，不留痕
  const collected = collectReviewIssues({ packet: packetRead.packet })
  // 缺视角或 issues JSON 损坏时，审稿单不成立；指标侧不把它计入有效三审。
  if (!collected.ok) {
    const missing = collected.missing_lenses.join('/')
    const bad = collected.bad_entries.map((b) => b.path).join('/')
    const detail = [missing && `缺视角 ${missing}`, bad && `损坏 ${bad}`].filter(Boolean).join('、')
    console.warn(`⚠ 三审产物异常（${detail}），该次定稿不计入有效三审`)
    return null
  }
  const { normalized, tier } = collected
  return {
    tier,
    downgrade: tier !== 'full',
    downgrade_reason: packetRead.packet.downgrade_reason ?? null,
    blockers: normalized.blockers.length,
    warnings: normalized.warnings.length,
    invalid: normalized.invalid_issues.length,
    lenses: collected.lenses_run,
  }
}

/** 采集 + 落账一站式（doFinalize 落账点直接调，内部 try 不外泄） */
export function collectAndAppend(
  bookRoot: string,
  workDir: string,
  ctx: CollectContext,
): void {
  const rec = collectMetrics(bookRoot, workDir, ctx)
  appendMetric(bookRoot, rec)
}
