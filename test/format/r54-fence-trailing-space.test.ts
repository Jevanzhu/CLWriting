/**
 * R54-E-2（五十四轮）回归：fm fence 容忍尾随空白。
 *
 * CommonMark 合法形态 `--- `（尾随空格，编辑器/同步盘常注入）此前不匹配
 * `/^---\r?$/`：起始侧不识别 → 整章判「无 fm」；仅起始识别而闭合带尾随空格 →
 * 整章判「fm 未闭合」。fail-loud 不丢数据但误伤面存在。修复后起始/闭合两侧
 * （splitFrontMatter + hasOpenFrontMatterFence 四处）同步容忍 [ \t]*。
 * 非 fence 形态不回归：`----`、`--- 分隔`、缩进 `  ---`（Q-16 块标量防线）均不识别。
 */
import { test, expect } from 'vitest'
import { splitFrontMatter, hasOpenFrontMatterFence } from '../../src/format/frontmatter-core.js'

test('R54-E-2: 基线不变——精确 --- 起止照常解析', () => {
  const r = splitFrontMatter('---\n标题: x\n---\n正文')
  expect(r).toEqual({ fmRaw: '标题: x', body: '正文' })
  expect(hasOpenFrontMatterFence('---\n标题: x\n')).toBe(true)
  expect(hasOpenFrontMatterFence('---\n标题: x\n---\n正文')).toBe(false)
})

test('R54-E-2: 起始 fence 尾随空格/制表符 → 照常解析（修复前整章判无 fm）', () => {
  expect(splitFrontMatter('--- \n标题: x\n---\n正文')).toEqual({ fmRaw: '标题: x', body: '正文' })
  expect(splitFrontMatter('---\t\n标题: x\n---\n正文')).toEqual({ fmRaw: '标题: x', body: '正文' })
  expect(hasOpenFrontMatterFence('--- \n章号: 1\n')).toBe(true)
})

test('R54-E-2: 闭合 fence 尾随空格 → 照常解析（修复前整章判未闭合）', () => {
  expect(splitFrontMatter('---\n标题: x\n--- \n正文')).toEqual({ fmRaw: '标题: x', body: '正文' })
  expect(splitFrontMatter('---\n标题: x\n---\t\n正文')).toEqual({ fmRaw: '标题: x', body: '正文' })
  expect(hasOpenFrontMatterFence('--- \n章号: 1\n--- \n正文')).toBe(false)
})

test('R54-E-2: CRLF + 尾随空格组合形态照常解析', () => {
  // 行尾 \r 保留原文字节（既有 CRLF 口径），只验 \r 剥除后的语义形态
  const r = splitFrontMatter('--- \r\n标题: x\r\n--- \r\n正文\r\n')
  expect(r?.fmRaw.replace(/\r/g, '')).toBe('标题: x')
  expect(r?.body.replace(/\r/g, '')).toBe('正文\n')
})

test('R54-E-2: 非 fence 形态不回归——四划线/带文尾随/缩进闭合仍不识别', () => {
  // 四划线不是 fence（R-12 收紧语义保持）
  expect(splitFrontMatter('----\n标题: x\n----\n正文')).toBeNull()
  // `--- 分隔`（空格后跟文字）不是 fence——[ \t]* 只吃空白，不吃正文
  expect(splitFrontMatter('--- 分隔\n正文')).toBeNull()
  // 缩进闭合（块标量内 `  ---`）不误判（Q-16 防线保持）
  expect(splitFrontMatter('---\n钩子: |\n  ---\n正文')).toBeNull()
})
