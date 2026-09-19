/**
 * 四轮-D402（2026-09-18 全量源码独立重评四轮修复批）回归：
 * 对话标签占比漂移阈值的基线对照值无上界——基线 ≥0.77 时 ×1.3 ≥1.0，而判定是
 * 严格 >，阈值不可达 → 高基线书的该漂移项被静默禁用。
 * 修复：外包 Math.min(…, 0.99) clamp；低基线行为不变（阈值仍 max(基线×1.3, 0.5)）。
 */
import { test, expect } from 'vitest'
import { aggregateStyleTrend } from '../../src/metrics/style.js'
import type { ChapterSample } from '../../src/metrics/style.js'

/** 造定稿章样本（只 dialogueTagRatio 有意义，其余维置中性值不产漂移） */
function sample(num: number, dialogueTagRatio: number): ChapterSample {
  return {
    num,
    title: `第${num}章`,
    stats: {
      overlongRatio: 0,
      adjStackHits: 0,
      dialogueTagRatio,
      parallelStreakMax: 0,
      summaryEnding: false,
      _dialogueLines: 3,
      sentenceLenVariance: 10,
      repeatRate: 0.05,
    },
  }
}

/** 10 章样本：前 5 章占比 0.1，后 5 章（6-10）满标签 1.0（漂移段，恰一窗长） */
function samplesWithDrift(): ChapterSample[] {
  return [1, 2, 3, 4, 5].map((n) => sample(n, 0.1))
    .concat([6, 7, 8, 9, 10].map((n) => sample(n, 1.0)))
}

test('四轮-D402: 基线 0.8 的高基线书连续超阈章仍可触发漂移（阈值 clamp 0.99）', () => {
  const baseline = {
    version: 1, frozenAt: 't', frozenFrom: 'test',
    byScene: {},
    overall: { overlongRatio: 0, adjStackHits: 0, dialogueTagRatio: 0.8, parallelStreakMax: 0, summaryEnding: false, sentenceLenVariance: 10, repeatRate: 0.05, _dialogueLines: 0 },
  }
  const trend = aggregateStyleTrend(samplesWithDrift(), 'long', baseline, { driftWindow: 5 })
  const tagDrift = trend.drifts.find((d) => d.metric === 'dialogueTag')
  // 修复前阈值 max(0.8*1.3, 0.5)=1.04 > 1.0 严格不可达 → 漂移静默禁用；
  // 修复后 min(1.04, 0.99)=0.99 < 1.0 可达
  expect(tagDrift, '高基线（0.8×1.3=1.04）不 clamp 时阈值不可达，漂移项静默失效').toBeDefined()
  // clamp 生效可见：报文口径按 clamp 后阈值 99%
  expect(tagDrift!.message).toContain('99%')
})

test('四轮-D402: 低基线行为不变——阈值仍 max(基线×1.3, 0.5)，clamp 不抬高', () => {
  const baseline = {
    version: 1, frozenAt: 't', frozenFrom: 'test',
    byScene: {},
    overall: { overlongRatio: 0, adjStackHits: 0, dialogueTagRatio: 0.2, parallelStreakMax: 0, summaryEnding: false, sentenceLenVariance: 10, repeatRate: 0.05, _dialogueLines: 0 },
  }
  const trend = aggregateStyleTrend(samplesWithDrift(), 'long', baseline, { driftWindow: 5 })
  const tagDrift = trend.drifts.find((d) => d.metric === 'dialogueTag')
  expect(tagDrift).toBeDefined()
  // max(0.2*1.3, 0.5)=0.5 → 报文 50%，未被 clamp 改写
  expect(tagDrift!.message).toContain('50%')
})
