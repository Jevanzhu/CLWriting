/**
 * 指标聚合 + 人话格式化（指标方案 §3.3）。
 *
 * 读 metrics.jsonl 的 MetricRecord[] → 聚合成 MetricsReport → 格式化成 stdout 表格。
 * 纯函数（除 formatMetricsReport 的字符串拼接），零模型零 IO。
 *
 * 支持 --last=N 看近 N 章/篇（opts.last）；kind 过滤（长/短篇分轨）。
 */

import type { MetricRecord } from './ledger.js'

/** 聚合后的成本/审查报告结构 */
export interface MetricsReport {
  count: number
  kind: 'long' | 'short' | 'mixed'
  range: { from: number; to: number } | null
  cost: {
    avgCalls: number
    overLimitChapters: number
    tokensNote: string // 本期恒「仅调用次数粒度」
    avgByStep: { outline: number; draft: number; review: number }
    calibration: {
      nearLimitUnits: number
      missingOutline: number
      missingDraft: number
      reviewedButNoReviewCall: number
      zeroCallUnits: number
      budgetNote: string
      accountingNote: string | null
    }
  }
  review: {
    fullRate: number
    downgradeRate: number
    avgBlockers: number
    topDowngradeReasons: { reason: string; n: number }[]
    lensCoverage: Record<string, number>
    reviewedCount: number // review 非 null 的记录数
  }
}

export interface AggregateOptions {
  last?: number
}

/**
 * 聚合成本/审查报告。
 * - opts.last：只取最近 N 条（按 num 升序后的尾部 N）
 * - 长短篇混存时 kind='mixed'，报告仍聚合（不分轨，beta 阶段够用）
 */
export function aggregateMetrics(records: MetricRecord[], opts: AggregateOptions = {}): MetricsReport {
  let pool = records
    .map((record, index) => ({ record, index }))
    .sort((a, b) => a.record.num - b.record.num || a.index - b.index)
    .map((entry) => entry.record)
  if (opts.last !== undefined && opts.last > 0 && pool.length > opts.last) {
    pool = pool.slice(-opts.last)
  }
  const count = pool.length

  const kinds = new Set(pool.map((r) => r.kind))
  const kind: MetricsReport['kind'] = kinds.size > 1 ? 'mixed' : (kinds.values().next().value ?? 'long')

  const range = count > 0
    ? { from: Math.min(...pool.map((r) => r.num)), to: Math.max(...pool.map((r) => r.num)) }
    : null

  // 成本
  const totalCalls = pool.reduce((sum, r) => sum + r.calls.total, 0)
  const overLimit = pool.filter((r) => r.calls.total > r.calls.limit).length
  const nearLimitUnits = pool.filter((r) => r.calls.limit > 0 && r.calls.total >= r.calls.limit * 0.8).length
  const missingOutline = pool.filter((r) => r.calls.outline === 0).length
  const missingDraft = pool.filter((r) => r.calls.draft === 0).length
  const reviewedButNoReviewCall = pool.filter((r) => r.review !== null && r.calls.review === 0).length
  const zeroCallUnits = pool.filter((r) => r.calls.total === 0).length
  const avgOutline = avg(pool.map((r) => r.calls.outline))
  const avgDraft = avg(pool.map((r) => r.calls.draft))
  const avgReview = avg(pool.map((r) => r.calls.review))
  const tokensNote = buildTokensNote(pool, kind)
  const avgCalls = count > 0 ? totalCalls / count : 0
  const budgetNote = buildBudgetNote(pool, avgCalls, overLimit, nearLimitUnits, kind)
  const accountingNote = buildAccountingNote({
    missingOutline,
    missingDraft,
    reviewedButNoReviewCall,
    zeroCallUnits,
    count,
    kind,
  })

  // 审查（只统计 review 非 null 的）
  const reviewed = pool.filter((r) => r.review !== null)
  const reviewedCount = reviewed.length
  const fullCount = reviewed.filter((r) => r.review!.tier === 'full').length
  const downgradeCount = reviewed.filter((r) => r.review!.downgrade).length
  const avgBlockers = avg(reviewed.map((r) => r.review!.blockers))

  // 降级原因 Top（只统计非空 reason）
  const reasonMap = new Map<string, number>()
  for (const r of reviewed) {
    const reason = r.review!.downgrade_reason
    if (reason) reasonMap.set(reason, (reasonMap.get(reason) ?? 0) + 1)
  }
  const topDowngradeReasons = [...reasonMap.entries()]
    .map(([reason, n]) => ({ reason, n }))
    .sort((a, b) => b.n - a.n)
    .slice(0, 5)

  // 视角覆盖（各 lens 出现次数）
  const lensCoverage: Record<string, number> = {}
  for (const r of reviewed) {
    for (const lens of r.review!.lenses) {
      lensCoverage[lens] = (lensCoverage[lens] ?? 0) + 1
    }
  }

  return {
    count,
    kind,
    range,
    cost: {
      avgCalls: count > 0 ? totalCalls / count : 0,
      overLimitChapters: overLimit,
      tokensNote,
      avgByStep: { outline: avgOutline, draft: avgDraft, review: avgReview },
      calibration: {
        nearLimitUnits,
        missingOutline,
        missingDraft,
        reviewedButNoReviewCall,
        zeroCallUnits,
        budgetNote,
        accountingNote,
      },
    },
    review: {
      fullRate: reviewedCount > 0 ? fullCount / reviewedCount : 0,
      downgradeRate: reviewedCount > 0 ? downgradeCount / reviewedCount : 0,
      avgBlockers,
      topDowngradeReasons,
      lensCoverage,
      reviewedCount,
    },
  }
}

/** 聚合报告 → 人话表格（stdout 输出，Unicode 盒线，宽 ≤80） */
export function formatMetricsReport(report: MetricsReport): string {
  if (report.count === 0) {
    return '尚无定稿指标。写完一章/篇定稿后再看（health --metrics）。\n'
  }
  const lines: string[] = []
  const unit = report.kind === 'short' ? '篇' : '章'
  const rangeStr = report.range ? `（第 ${report.range.from}–${report.range.to} ${unit}）` : ''
  lines.push(`成本/审查体检 · ${report.count} 条记录${rangeStr}`)
  lines.push('─'.repeat(48))

  // 成本段
  lines.push('【成本】')
  lines.push(`  平均调用 ${report.cost.avgCalls.toFixed(1)} 次/${unit}` +
    `（大纲 ${report.cost.avgByStep.outline.toFixed(1)} / 草稿 ${report.cost.avgByStep.draft.toFixed(1)} / 审查 ${report.cost.avgByStep.review.toFixed(1)}）`)
  lines.push(`  超上限 ${report.cost.overLimitChapters} ${unit}`)
  lines.push(`  token：${report.cost.tokensNote}`)
  lines.push(`  预算校准：${report.cost.calibration.budgetNote}`)
  if (report.cost.calibration.accountingNote) {
    lines.push(`  记账提示：${report.cost.calibration.accountingNote}`)
  }
  lines.push('')

  // 审查段
  lines.push('【审查】')
  if (report.review.reviewedCount === 0) {
    lines.push('  无三审记录（短篇合审或未三审的定稿，诚实降级）')
  } else {
    lines.push(`  满审率 ${(report.review.fullRate * 100).toFixed(0)}% · 降级率 ${(report.review.downgradeRate * 100).toFixed(0)}%` +
      `（${report.review.reviewedCount}/${report.count} 条有三审记录）`)
    lines.push(`  平均阻断项 ${report.review.avgBlockers.toFixed(1)}`)
    if (report.review.topDowngradeReasons.length > 0) {
      const reasons = report.review.topDowngradeReasons.map((r) => `${r.reason}×${r.n}`).join('、')
      lines.push(`  降级原因 Top：${reasons}`)
    }
    const lensEntries = Object.entries(report.review.lensCoverage)
    if (lensEntries.length > 0) {
      lines.push(`  视角覆盖：${lensEntries.map(([lens, n]) => `${lens} ${n}`).join('、')}`)
    }
  }
  lines.push('')
  return lines.join('\n')
}

function avg(nums: number[]): number {
  if (nums.length === 0) return 0
  return nums.reduce((a, b) => a + b, 0) / nums.length
}

/**
 * 生成 token 维度的人话备注（成本闭环 §2 D3）。
 * - 全部记录无 token → 「仅调用次数粒度」（宿主未回填，诚实标注）
 * - 全部有 → 平均 token/单位
 * - 部分 → 标注覆盖度 + 平均（避免「部分和」被误读为全集）
 */
function buildTokensNote(pool: MetricRecord[], kind: MetricsReport['kind']): string {
  const unit = kind === 'short' ? '篇' : '章'
  const withTokens = pool.filter((r) => r.tokens !== null && Number.isFinite(r.tokens))
  if (withTokens.length === 0) return '仅调用次数粒度（真实 token 未采集）'
  const tokenAvg = avg(withTokens.map((r) => r.tokens as number))
  const rounded = Math.round(tokenAvg)
  if (withTokens.length === pool.length) {
    return `平均 ${rounded} token/${unit}`
  }
  return `部分 token 采集（${withTokens.length}/${pool.length} ${unit}有，平均 ${rounded}）`
}

function buildBudgetNote(
  pool: MetricRecord[],
  avgCalls: number,
  overLimit: number,
  nearLimit: number,
  kind: MetricsReport['kind'],
): string {
  const unit = kind === 'short' ? '篇' : '章'
  if (pool.length === 0) return '暂无样本'
  const limits = [...new Set(pool.map((r) => r.calls.limit))]
  const limitText = limits.length === 1 ? `默认上限 ${limits[0]}` : `上限 ${limits.join('/')}`
  if (overLimit > 0) {
    return `${limitText}，平均 ${avgCalls.toFixed(1)}；${overLimit} ${unit}超限，建议用实测调高 calls_per_chapter 或降低 best-of-N/审查档位`
  }
  if (nearLimit > 0) {
    return `${limitText}，平均 ${avgCalls.toFixed(1)}；${nearLimit} ${unit}接近上限，50 章验证后再校准默认值`
  }
  return `${limitText}，平均 ${avgCalls.toFixed(1)}，未见触顶，先保持默认`
}

function buildAccountingNote(input: {
  missingOutline: number
  missingDraft: number
  reviewedButNoReviewCall: number
  zeroCallUnits: number
  count: number
  kind: MetricsReport['kind']
}): string | null {
  const unit = input.kind === 'short' ? '篇' : '章'
  const parts: string[] = []
  if (input.zeroCallUnits > 0) parts.push(`${input.zeroCallUnits}/${input.count} ${unit}调用全为 0`)
  if (input.missingOutline > 0) parts.push(`${input.missingOutline} ${unit} outline 为 0`)
  if (input.missingDraft > 0) parts.push(`${input.missingDraft} ${unit} draft 为 0`)
  if (input.reviewedButNoReviewCall > 0) parts.push(`${input.reviewedButNoReviewCall} ${unit}有三审但 review 记账为 0`)
  if (parts.length === 0) return null
  return `${parts.join('；')}，疑似宿主漏记 record-call 或 review collect 未落账`
}
