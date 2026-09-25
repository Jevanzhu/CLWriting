/**
 * R57-D-2（五十七轮）回归：sanitizeFullFileName 扩展名段消毒字符集对齐词干段
 * 同款 `[\\/:*?"<>|]`——原 ext 段只替换路径分隔符 `\` `/`，win 保留字符落在最后
 * 一段点之后（如 `a.md:2` 的冒号）即漏网进扩展名。ext 以点开头，首点保留逻辑不变。
 *
 * 主审勘误记档：`a.v:2.md` 这类「非法字符在非末段点之前」的形态本来就由惰性回溯
 * 救回（stem=`a.v:2` → 词干段消毒），不属本缺陷，用例按正确形态断言防回归。
 */
import { describe, expect, it } from 'vitest'
import { sanitizeFullFileName } from '../../src/format/filename.js'

describe('R57-D-2: 扩展名段 win 保留字符消毒（对齐词干段字符集）', () => {
  it('a.md:2 → ext 段冒号替换 _（修复前 ext=.md:2 冒号留存）', () => {
    expect(sanitizeFullFileName('a.md:2')).toBe('a.md_2')
  })

  it('win 保留字符逐个落 ext 段均替换（< > | * ? " 与反斜杠）', () => {
    expect(sanitizeFullFileName('a.md<b>')).toBe('a.md_b_')
    expect(sanitizeFullFileName('章.md|末')).toBe('章.md_末')
    expect(sanitizeFullFileName('a.md*1')).toBe('a.md_1')
    expect(sanitizeFullFileName('a.md?1')).toBe('a.md_1')
    expect(sanitizeFullFileName('a.md"q"')).toBe('a.md_q_')
  })

  it('词干行为不回归：非法字符在非末段点之前仍由惰性回溯落词干段消毒', () => {
    // a.v:2.md 拆分 = stem「a.v:2」+ ext「.md」——冒号由词干段替换，ext 保留原样
    expect(sanitizeFullFileName('a.v:2.md')).toBe('a.v_2.md')
  })

  it('首点保留 + 正常扩展名不回退（点不在替换集内）', () => {
    expect(sanitizeFullFileName('章.md')).toBe('章.md')
    expect(sanitizeFullFileName('第一章.序')).toBe('第一章.序')
  })
})
