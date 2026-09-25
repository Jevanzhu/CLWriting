import { test, expect } from 'vitest'
import { SHORT_DEFAULTS } from '../../src/shared/short-defaults.js'
import { recommendShortChecks } from '../../src/install/data.js'
import { analyzeShortCollection } from '../../src/metrics/short-index.js'

// R0912-ds41（P3-6）防漂移锚：短篇默认表唯一正本在 shared/short-defaults.ts，
// 此前 metrics（DEFAULT_SHORT_CONFIG）与 install（DEFAULT_SHORT_CHECKS）各持一份
// 12 行逐字相同的表。本测试断言两消费方展开后的默认结果与正本一致——防止有人
// 回头只改一处（或新增旁路默认表）造成漂移。

test('R0912-ds41: install 未命中题材回落值与 shared 正本逐字段一致', () => {
  // recommendShortChecks 是 install 侧完整 10 键默认表的唯一可观测出口
  expect(recommendShortChecks('冷门实验')).toEqual({ ...SHORT_DEFAULTS })
})

test('R0912-ds41: metrics 缺省展开的画像与目标池和 shared 正本一致', () => {
  const report = analyzeShortCollection([], undefined)
  expect(report.platform.profile).toBe(SHORT_DEFAULTS.profile)
  expect(report.platform.wordMin).toBe(SHORT_DEFAULTS.word_min)
  expect(report.platform.wordMax).toBe(SHORT_DEFAULTS.word_max)
  expect(report.platform.hookWindow).toBe(SHORT_DEFAULTS.opening_env_chars)
  expect(report.platformTargets).toEqual({
    targetEmotions: SHORT_DEFAULTS.target_emotions,
    targetReversalTypes: SHORT_DEFAULTS.target_reversal_types,
    targetEndingFlavors: SHORT_DEFAULTS.target_ending_flavors,
  })
})
