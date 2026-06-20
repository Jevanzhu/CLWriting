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
  let pool = [...records]
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
  const avgOutline = avg(pool.map((r) => r.calls.outline))
  const avgDraft = avg(pool.map((r) => r.calls.draft))
  const avgReview = avg(pool.map((r) => r.calls.review))

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
      tokensNote: '仅调用次数粒度（真实 token 未采集）',
      avgByStep: { outline: avgOutline, draft: avgDraft, review: avgReview },
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
