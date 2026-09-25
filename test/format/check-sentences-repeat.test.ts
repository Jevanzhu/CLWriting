/**
 * B-6（二十九轮）：复读检查双口径——比率（既有）+ 绝对重复字符量（新增）。
 * 比率随章长稀释：大章里百字级复读块占比被总 n-gram 摊薄漏报；绝对量兜底。
 */
import { test, expect } from 'vitest'
import { ngramRepeatRate } from '../../src/format/sentences.js'
import { checkRepeat } from '../../src/check/count.js'

const N = 8

test('B-6: ngramRepeatRate 返回绝对重复字符量 repeatChars（= repeatInstances × n 恒等）', () => {
  const body = '他大步流星地走了过去。他大步流星地走了过去。她轻轻微微地笑了起来。'
  const r = ngramRepeatRate(body, N)
  expect(r.repeatInstances).toBeGreaterThan(0)
  expect(r.repeatChars).toBe(r.repeatInstances * N) // 每个重复实例折算 n 字
  expect(ngramRepeatRate('完全不同的三句话。彼此毫无重复。各自独立成句。', N).repeatChars).toBe(0)
})

/** 造大章：filler 句两两无共享 8-gram（数字高位密排保证任一滑窗含独有位）+ 复读块重复两次 */
function diluteChapter(block: string): string {
  const fillers: string[] = []
  for (let i = 0; i < 60; i++) {
    fillers.push(`夜${i}霜${i + 1}灯${i + 2}阶${i + 3}甲${i + 4}声${i + 5}。`)
  }
  fillers.splice(10, 0, block)
  fillers.splice(30, 0, block)
  return fillers.join('\n')
}

test('B-6: 大章百字级复读——比率不超阈（稀释）但绝对量超阈也报（双口径兜漏报）', () => {
  // ~37 字复读块重复两次：repeatChars = 30 gram × 8 = 240 > 200；
  // 全章 ~800 n-gram 总量把比率摊到 ~4%（修复前漏报）
  const block = '他从怀中取出那枚青铜令牌翻来覆去看了许久始终想不起它何时回到自己手中这件事'
  const body = diluteChapter(block)
  const { rate, repeatChars } = ngramRepeatRate(body, N)
  expect(rate).toBeLessThanOrEqual(0.15) // 比率口径不报（稀释面）
  expect(repeatChars).toBeGreaterThan(200) // 绝对量口径兜住
  const items = checkRepeat(body).items
  expect(items).toHaveLength(1)
  expect(items[0]!.checkId).toBe('repeat')
  expect(items[0]!.level).toBe('yellow')
  expect(items[0]!.message).toContain('重复字符量')
})

test('B-6: 小章高密度复读仍走比率口径（message 不变）；正常文本双口径全静默', () => {
  const dense = '他大步流星地走了过去。他大步流星地走了过去。他大步流星地走了过去。'
  const items = checkRepeat(dense).items
  expect(items).toHaveLength(1)
  expect(items[0]!.message).toContain('复读率') // 比率口径 message 保持原文案
  expect(items[0]!.message).not.toContain('重复字符量')
  // 正常行文：比率与绝对量都不过阈 → 不报
  expect(checkRepeat('夜风掀动窗纸。他把信折好收进袖中，吹熄了灯。院里只余更声与犬吠。').items).toHaveLength(0)
})
