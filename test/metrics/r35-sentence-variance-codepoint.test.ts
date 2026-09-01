/**
 * R35-23（三十五轮）回归：句长方差按码点口径（astral 字符一符计 1）。
 *
 * 缺陷：computeSentenceLenVariance 用 UTF-16 码元（.length）计句长——同文件 charCount
 * （R75-1）与 count.ts 超长句判定（R73-19）均已改码点，基线冻结与实时检查同 metric
 * 不同单位。纯 BMP 文本两口径等值（既有用例不受影响），astral 字符（emoji/扩展区）
 * 下 UTF-16 口径句长翻倍、方差虚高。
 */
import { test, expect } from 'vitest'
import { computeSentenceLenVariance } from '../../src/metrics/style.js'
import { splitSentences } from '../../src/format/sentences.js'

test('R35-23: 等码点长度的句子（其一含 astral 字符）方差为 0——修复前 UTF-16 口径虚高', () => {
  // 两句均 9 个码点：'😀'×5 + '望着河面'（码点 9 / UTF-16 14） vs '他望着河流的尽头处'（9/9）
  // 码点口径等长 → 方差 0；修复前 UTF-16 口径 14 vs 9 → 方差 6.25
  const body = '😀😀😀😀😀望着河面。他望着河流的尽头处。'
  expect(computeSentenceLenVariance(body)).toBe(0)

  // 前提自证：同切句下 UTF-16 口径确实大于 0（口径分歧真实存在，用例不是恒真）
  const sentences = splitSentences(body)
  const utf16Lens = sentences.map((s) => s.length)
  expect(new Set(utf16Lens).size).toBeGreaterThan(1)
})

test('R35-23: 与手算码点方差逐值一致（公式口径不变，仅长度单位改码点）', () => {
  const body = '短句。这是一个中等长度的句子。'
  const sentences = splitSentences(body)
  const lens = sentences.map((s) => [...s].length)
  const mean = lens.reduce((a, b) => a + b, 0) / lens.length
  const expected = lens.reduce((sum, len) => sum + (len - mean) ** 2, 0) / lens.length
  expect(computeSentenceLenVariance(body)).toBeCloseTo(expected, 10)
})
