/**
 * 采集一条定稿指标记录（指标方案 §3/§4）。
 *
 * 从工作区回收两类过程数据（定稿后无法重算）：
 * - 成本（调用次数）：readAiCallBudget 读 .ai-calls.json（clear 前）
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

/**
 * 组装一条成本/审查 MetricRecord。
 * 不写盘（append 由调用方决定）；任何子项缺失都诚实降级（calls 全 0 / review=null），不抛异常。
 */
export function collectMetrics(
  _bookRoot: string,
  workDir: string,
  ctx: CollectContext,
): MetricRecord {
  const calls = collectCalls(workDir, ctx.config)
  const review = collectReview(workDir)
  return {
    kind: ctx.kind,
    num: ctx.num,
    title: ctx.title,
    words: countWords(ctx.body),
    at: new Date().toISOString(),
    calls,
    tokens: null, // 真实 token 未采集，预留 null（OQ1）
    review,
  }
}

/** 采集调用次数分解。.ai-calls.json 缺失（未调用 AI）→ 全 0。 */
function collectCalls(workDir: string, config: BookConfig): CallBreakdown {
  const read = readAiCallBudget(workDir)
  if (!read.ok || read.record === null) {
    const limit = config.budget.calls_per_chapter
    return { outline: 0, draft: 0, review: 0, total: 0, limit }
  }
  const record = read.record
  const byStep = new Map<AiCallStep, number>()
  for (const entry of record.entries) {
    // review + review-combined 都归 review
    const bucket: AiCallStep = entry.step === 'review-combined' ? 'review' : entry.step
    byStep.set(bucket, (byStep.get(bucket) ?? 0) + entry.calls)
  }
  return {
    outline: byStep.get('outline') ?? 0,
    draft: byStep.get('draft') ?? 0,
    review: byStep.get('review') ?? 0,
    total: record.used,
    limit: resolveCallLimit(config, record.limit_override),
  }
}

/**
 * 采集审查档位/降级/问题数。
 * 复用 review 模块的 readReviewPacket + collectReviewIssues（零改 review）。
 * 三审/ 或 packet.json 缺失 → null（短篇合审/未三审/旧工作区诚实降级）。
 */
function collectReview(workDir: string): ReviewMetrics | null {
  const packetRead = readReviewPacket(workDir)
  if (!packetRead.ok) return null
  const collected = collectReviewIssues({ packet: packetRead.packet })
  // 缺视角或 issues JSON 损坏时，审稿单不成立；指标侧不把它计入有效三审。
  if (!collected.ok) return null
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
