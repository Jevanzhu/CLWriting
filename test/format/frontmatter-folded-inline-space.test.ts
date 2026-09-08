/**
 * 重审-07（2026-09-07 全量代码重审 §四.7）回归：folded（`>`）块标量解析不得折叠
 * 行内双空格。
 *
 * foldSegs 的 join(' ') 后 `replace(/  +/g, ' ')` 把行内连续空格折叠成单空格——
 * YAML folded 语义只清行尾空白，行内多空格是字面内容；读改写往返（parseFlat →
 * stringifyFlat）篡改手写多行值。修复 = 去掉双空格折叠，保留 `replace(/ +$/, '')`
 * 行尾清理（两处 segs.push 同款）。
 */
import { test, expect } from 'vitest'
import { parseFlat, stringifyFlat } from '../../src/format/frontmatter.js'

test('重审-07: `>` 块行内双空格 → 解析值保留（现状被折叠 → 红）', () => {
  const fmRaw = ['摘要: >', '  一句话  保留双空格', '  接着说'].join('\n')
  expect(parseFlat(fmRaw).get('摘要')).toBe('一句话  保留双空格 接着说')
})

test('重审-07: `>` 块多行行内双空格往返（parse → stringify → parse）不漂移', () => {
  const fmRaw = ['钩子: >', '  第一句  有双空格', '  第二句  也有'].join('\n')
  const v1 = parseFlat(fmRaw).get('钩子')
  expect(v1).toBe('第一句  有双空格 第二句  也有')
  const roundTrip = parseFlat(stringifyFlat(new Map([['钩子', v1]])))
  expect(roundTrip.get('钩子')).toBe(v1)
})

test('重审-07: 不回归 Z-20——folded 空行仍是段落边界；行尾空格仍清理', () => {
  // 空行分段（Z-20 语义）
  expect(parseFlat('钩子: >\n  第一段\n\n  第二段').get('钩子')).toBe('第一段\n第二段')
  // 行尾空格清理口径不变（join 后段尾不留空格）
  expect(parseFlat(['钩子: >', '  第一句  ', '  第二句'].join('\n')).get('钩子')).toBe('第一句 第二句')
})
