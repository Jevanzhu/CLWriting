/**
 * 对话标签动词集：SPEECH_VERBS 单源对齐后的标签占比口径（R28-8）。
 *
 * 档源：原 r28-count-fixes.test.ts 的 R28-8 组（同文件 R28-2/R28-9 组属节数守恒
 * 家族，并入 section-count-fence.test.ts）。
 *
 * R28-8（二十八轮）：DIALOGUE_TAG_RE 动词集只含 说/道/问/喊/叫/答/叹/笑 8 个，
 * 窄于 SPEECH_ATTRIBUTION_RE 的 21 个 → 标签占比分子系统性偏低（漏检向黄）。
 * 抽 SPEECH_VERBS 单源对齐。
 */
import { test, expect } from 'vitest'
import { computeStyleMetrics } from '../../src/check/count.js'

function tagRatio(line: string): number {
  return computeStyleMetrics(line, { maxDialogueTagRatio: 0.3 }).dialogueTagRatio
}

test('R28-8: 新动词（骂/嘀咕/喃喃/吼）命中标签占比', () => {
  // 修复前 8 动词集不含 骂/嘀咕/喃喃/吼 → 占比 0（漏检向黄）。
  // 注意用裸动词收尾：骂道/吼道 在修复前可借动词「道」命中，测不出扩展
  expect(tagRatio('「滚开。」他骂。')).toBe(1)
  expect(tagRatio('「走吧。」她嘀咕。')).toBe(1)
  expect(tagRatio('「嗯。」他喃喃。')).toBe(1)
  expect(tagRatio('「住手！」老周吼。')).toBe(1)
})

test('R28-8: 锚定豁免不回潮，「了后接一」登记不动仍不计', () => {
  // R26-11 反例不回归：构词语素（喝出）不算标签
  expect(tagRatio('「嗯。」汤里喝出了咸味。')).toBe(0)
  // 「他骂了一声，」——了 后接数词不满足双侧锚定（R28-8 登记不动，维持不计）
  expect(tagRatio('「去。」他骂了一声，转身走了。')).toBe(0)
  // 既有动词语义不变
  expect(tagRatio('「走吧。」林晚喊道。')).toBe(1)
})
