import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readBookConfig } from '../../src/format/yaml.js'
import {
  analyzeShortCollection,
  analyzeShortQualityTrend,
  analyzeShortRepairPlan,
  analyzeShortSeriesMotifs,
  formatShortQualityTrend,
  formatShortRepairPlan,
  formatShortSeriesMotifs,
  formatShortSubmissionView,
  scanShortCollection,
} from '../../src/metrics/short-index.js'

const FIXTURE_ROOT = fileURLToPath(new URL('../fixtures/short-regression/短篇回归集', import.meta.url))

describe('短篇真实样本回归集', () => {
  it('固定 5 篇样本能跑完整短篇分析链路', () => {
    const cfg = readBookConfig(join(FIXTURE_ROOT, 'book.yaml')).config
    const entries = scanShortCollection(FIXTURE_ROOT)

    expect(entries).toHaveLength(5)
    expect(entries.map((entry) => entry.num)).toEqual([1, 2, 3, 4, 5])
    expect(
      entries
        .filter((entry) => entry.reversalQuality.score < 70)
        .map((entry) => ({
          num: entry.num,
          title: entry.title,
          score: entry.reversalQuality.score,
          issues: entry.reversalQuality.issues,
        })),
    ).toEqual([])

    const collection = analyzeShortCollection(entries, cfg.short)
    expect(collection.platform.profile).toBe('多题材短篇回归')
    expect(collection.planning.emotions.length).toBeGreaterThanOrEqual(3)
    expect(collection.platform.targetGaps).toContain('反转 死者反转')

    const repair = analyzeShortRepairPlan(entries, cfg.short)
    const repairText = formatShortRepairPlan(repair)
    expect(repair.items.every((item) => item.priority !== '高')).toBe(true)
    expect(repairText).toContain('短篇重修计划')

    const trend = analyzeShortQualityTrend(entries, cfg.short)
    expect(formatShortQualityTrend(trend)).toContain('短篇质量趋势评分')

    const series = analyzeShortSeriesMotifs(entries, cfg.short)
    expect(series.declaredMotifs).toContain('七号公寓')
    expect(series.repeatedMotifs.map((item) => item.value)).toContain('旧收音机')
    expect(formatShortSeriesMotifs(series)).toContain('短篇系列母题')

    const submission = formatShortSubmissionView(entries, cfg.short, cfg.book.title, 'xiaohongshu')
    expect(submission).toContain('# 投稿视图-短篇回归集-小红书故事号')
    expect(submission).toContain('一句话钩子')
  })
})
