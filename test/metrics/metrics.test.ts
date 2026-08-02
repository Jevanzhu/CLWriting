import { test, expect } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  appendMetric,
  readMetrics,
  metricsPath,
  trimMetricsAfter,
  type MetricRecord,
} from '../../src/metrics/ledger.js'
import { aggregateMetrics, formatMetricsReport } from '../../src/metrics/report.js'
import { DEFAULT_CONFIG, writeBookConfig } from '../../src/format/yaml.js'
import { rebuild } from '../../src/cache/rebuild.js'
import type { BookConfig } from '../../src/format/types.js'

// ── ledger.ts ─────────────────────────────────────

function sampleRecord(overrides: Partial<MetricRecord> = {}): MetricRecord {
  return {
    kind: 'long',
    num: 1,
    title: '第一章',
    words: 3000,
    at: '2026-06-20T00:00:00.000Z',
    calls: { outline: 1, draft: 1, review: 3, total: 5, limit: 8 },
    tokens: null,
    review: {
      tier: 'full',
      downgrade: false,
      downgrade_reason: null,
      blockers: 0,
      warnings: 2,
      invalid: 0,
      lenses: ['reader', 'editor', 'continuity'],
    },
    ...overrides,
  }
}

const config: BookConfig = { ...DEFAULT_CONFIG, budget: { ...DEFAULT_CONFIG.budget, calls_per_chapter: 8 } }

test('ledger: append + read 往返一致', () => {
  const root = mkdtempSync(join(tmpdir(), 'metrics-ledger-'))
  appendMetric(root, sampleRecord({ num: 1 }))
  appendMetric(root, sampleRecord({ num: 2, title: '第二章' }))
  const records = readMetrics(root)
  expect(records).toHaveLength(2)
  expect(records[0]!.num).toBe(1)
  expect(records[1]!.title).toBe('第二章')
  rmSync(root, { recursive: true, force: true })
})

test('ledger: 文件不存在 → 空数组（友好，不崩）', () => {
  const root = mkdtempSync(join(tmpdir(), 'metrics-ledger-'))
  expect(readMetrics(root)).toEqual([])
  rmSync(root, { recursive: true, force: true })
})

test('ledger: 坏行跳过，好行正常返回（容错）', () => {
  const root = mkdtempSync(join(tmpdir(), 'metrics-ledger-'))
  mkdirSync(join(root, '.cache'), { recursive: true })
  // 手写：一行好 + 一行坏 + 一行好
  const fp = metricsPath(root)
  const good = JSON.stringify(sampleRecord({ num: 1 }))
  const bad = '{not valid json'
  const good2 = JSON.stringify(sampleRecord({ num: 2 }))
  writeFileSync(fp, `${good}\n${bad}\n${good2}\n`, 'utf-8')
  const records = readMetrics(root)
  expect(records).toHaveLength(2)
  expect(records.map((r) => r.num)).toEqual([1, 2])
  rmSync(root, { recursive: true, force: true })
})

test('ledger: 缺关键字段的记录被丢弃（强类型校验）', () => {
  const root = mkdtempSync(join(tmpdir(), 'metrics-ledger-'))
  mkdirSync(join(root, '.cache'), { recursive: true })
  const fp = metricsPath(root)
  const noCalls = JSON.stringify({ kind: 'long', num: 1, title: 'x', words: 1, at: 't', tokens: null, review: null })
  const badKind = JSON.stringify({ ...sampleRecord(), kind: 'bad' })
  const ok = JSON.stringify(sampleRecord({ num: 5 }))
  writeFileSync(fp, `${noCalls}\n${badKind}\n${ok}\n`, 'utf-8')
  expect(readMetrics(root)).toHaveLength(1)
  expect(readMetrics(root)[0]!.num).toBe(5)
  rmSync(root, { recursive: true, force: true })
})

test('ledger: 回滚裁剪只删除同轨目标之后的指标', () => {
  const root = mkdtempSync(join(tmpdir(), 'metrics-ledger-'))
  appendMetric(root, sampleRecord({ kind: 'long', num: 1 }))
  appendMetric(root, sampleRecord({ kind: 'long', num: 2 }))
  appendMetric(root, sampleRecord({ kind: 'long', num: 3 }))
  appendMetric(root, sampleRecord({ kind: 'short', num: 1, title: '短篇一' }))

  const trimmed = trimMetricsAfter(root, 'long', 2)
  const records = readMetrics(root)
  expect(trimmed.removed).toBe(1)
  expect(records.map((r) => `${r.kind}:${r.num}`)).toEqual(['long:1', 'long:2', 'short:1'])
  rmSync(root, { recursive: true, force: true })
})

// ── report.ts ─────────────────────────────────────

test('report: 空记录 → 友好提示', () => {
  const report = aggregateMetrics([])
  expect(formatMetricsReport(report)).toContain('尚无定稿指标')
})

test('report: 聚合平均调用 / 超限章次 / 满审率 / 降级率正确', () => {
  const records: MetricRecord[] = [
    sampleRecord({ num: 1, calls: { outline: 1, draft: 1, review: 3, total: 5, limit: 8 } }),
    sampleRecord({ num: 2, calls: { outline: 1, draft: 1, review: 3, total: 9, limit: 8 } }), // 超限
    sampleRecord({
      num: 3,
      calls: { outline: 1, draft: 1, review: 1, total: 3, limit: 8 },
      review: { tier: 'combined', downgrade: true, downgrade_reason: '调用不足', blockers: 1, warnings: 0, invalid: 0, lenses: ['reader'] },
    }),
  ]
  const report = aggregateMetrics(records)
  expect(report.count).toBe(3)
  expect(report.cost.avgCalls).toBeCloseTo((5 + 9 + 3) / 3, 5) // 5.667
  expect(report.cost.overLimitChapters).toBe(1) // 第2章 9>8
  expect(report.cost.calibration.nearLimitUnits).toBe(1)
  expect(report.cost.calibration.budgetNote).toContain('1 章超限')
  expect(report.review.reviewedCount).toBe(3)
  expect(report.review.fullRate).toBeCloseTo(2 / 3, 5) // 第1/2章满审
  expect(report.review.downgradeRate).toBeCloseTo(1 / 3, 5) // 第3章降级
  expect(report.review.avgBlockers).toBeCloseTo(1 / 3, 5)
  expect(report.review.topDowngradeReasons[0]).toEqual({ reason: '调用不足', n: 1 })
})

test('report: 接近预算上限时给 beta 校准提示', () => {
  const records: MetricRecord[] = [
    sampleRecord({ num: 1, calls: { outline: 1, draft: 2, review: 3, total: 6, limit: 8 } }),
    sampleRecord({ num: 2, calls: { outline: 1, draft: 2, review: 4, total: 7, limit: 8 } }),
  ]
  const report = aggregateMetrics(records)
  expect(report.cost.calibration.nearLimitUnits).toBe(1)
  expect(report.cost.calibration.budgetNote).toContain('接近上限')
  expect(formatMetricsReport(report)).toContain('预算校准')
})

test('report: outline/draft/review 漏记时给宿主软提示', () => {
  const records: MetricRecord[] = [
    sampleRecord({
      num: 1,
      calls: { outline: 0, draft: 1, review: 3, total: 4, limit: 8 },
    }),
    sampleRecord({
      num: 2,
      calls: { outline: 1, draft: 0, review: 0, total: 1, limit: 8 },
      review: {
        tier: 'full',
        downgrade: false,
        downgrade_reason: null,
        blockers: 0,
        warnings: 0,
        invalid: 0,
        lenses: ['reader', 'editor', 'continuity'],
      },
    }),
  ]
  const report = aggregateMetrics(records)
  expect(report.cost.calibration.missingOutline).toBe(1)
  expect(report.cost.calibration.missingDraft).toBe(1)
  expect(report.cost.calibration.reviewedButNoReviewCall).toBe(1)
  expect(report.cost.calibration.accountingNote).toContain('outline 为 0')
  expect(report.cost.calibration.accountingNote).toContain('draft 为 0')
  expect(formatMetricsReport(report)).toContain('记账提示')
})

test('report: --last=N 只取最近 N 条', () => {
  const records = [5, 1, 4, 2, 3].map((n) => sampleRecord({ num: n }))
  const report = aggregateMetrics(records, { last: 2 })
  expect(report.count).toBe(2)
  expect(report.range).toEqual({ from: 4, to: 5 })
})

test('report: review 全 null（短篇合审）→ 审查段诚实降级', () => {
  const records = [sampleRecord({ num: 1, review: null }), sampleRecord({ num: 2, review: null })]
  const report = aggregateMetrics(records)
  expect(report.review.reviewedCount).toBe(0)
  expect(formatMetricsReport(report)).toContain('无三审记录')
})

test('report: token 维度三态备注', () => {
  // 全 null → 仅调用次数粒度
  const noneReport = aggregateMetrics([sampleRecord({ num: 1, tokens: null }), sampleRecord({ num: 2, tokens: null })])
  expect(noneReport.cost.tokensNote).toContain('仅调用次数粒度')

  // 全有 → 平均 token/章
  const allReport = aggregateMetrics([
    sampleRecord({ num: 1, tokens: 4000 }),
    sampleRecord({ num: 2, tokens: 6000 }),
  ])
  expect(allReport.cost.tokensNote).toContain('平均 5000 token/章')

  // 部分 → 标注覆盖度
  const partialReport = aggregateMetrics([
    sampleRecord({ num: 1, tokens: 3000 }),
    sampleRecord({ num: 2, tokens: null }),
  ])
  expect(partialReport.cost.tokensNote).toContain('部分 token 采集')
  expect(partialReport.cost.tokensNote).toContain('1/2')
})

// ── rebuild 守护（#6）──────────────────────────────

test('守护: 删 index.db rebuild 后 metrics.jsonl 不丢（rebuild 不碰 .cache 其它文件）', () => {
  const root = mkdtempSync(join(tmpdir(), 'metrics-rebuild-'))
  mkdirSync(join(root, '.cache'), { recursive: true })
  appendMetric(root, sampleRecord({ num: 1 }))
  appendMetric(root, sampleRecord({ num: 2 }))
  expect(readMetrics(root)).toHaveLength(2)

  // rebuild index.db（模拟 finalize 后的重建）
  writeBookConfig(join(root, 'book.yaml'), config)
  rebuild(root, join(root, '.cache', 'index.db'))

  // metrics.jsonl 仍在、内容不丢
  expect(existsSync(metricsPath(root))).toBe(true)
  expect(readMetrics(root)).toHaveLength(2)
  rmSync(root, { recursive: true, force: true })
})
