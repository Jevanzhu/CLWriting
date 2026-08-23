/**
 * Y-6 / Y-21（第五十七轮）回归——frontmatter 解析边界两件。
 *
 * Y-6：CRLF 文件的块标量值不嵌 \r（split('\n') 保留 \r 尾，此前块行原样入值，
 * 平铺值行有 trim 无此问题）；往返（parse → stringify）后无 \r 残留。
 * Y-21：splitInlineArray 单引号状态机——手写 `['悬疑,推理']` 不在引号内逗号处错切。
 */
import { describe, it, expect } from 'vitest'
import { parseFlat, stringifyFlat, parseValue, splitInlineArray } from '../../src/format/frontmatter.js'

describe('Y-6: 块标量 CRLF', () => {
  it('CRLF fm 的 literal 块标量值无 \\r，往返不产生混合行尾', () => {
    const fmRaw = '标题: 测试\r\n核心反转: |\r\n  第一行\r\n  第二行\r\n状态: 进行中\r\n'
    const m = parseFlat(fmRaw)
    expect(m.get('核心反转')).toBe('第一行\n第二行')
    expect(String(m.get('核心反转')).includes('\r')).toBe(false)
    // 平铺值同样无 \r（trim 既有行为）
    expect(m.get('标题')).toBe('测试')
    // 往返：stringify 后再 parse 值等价
    const rt = parseFlat(stringifyFlat(m))
    expect(rt.get('核心反转')).toBe('第一行\n第二行')
  })

  it('CRLF folded（>）块标量同治', () => {
    const fmRaw = '钩子: >\r\n  铺垫\r\n  反转\r\n'
    const m = parseFlat(fmRaw)
    expect(String(m.get('钩子')).includes('\r')).toBe(false)
  })
})

describe('Y-21: splitInlineArray 单引号', () => {
  it("['悬疑,推理'] 不在引号内逗号处错切（经 parseValue 全链）", () => {
    expect(parseValue("['悬疑,推理']")).toEqual(['悬疑,推理'])
  })

  it('双引号既有行为保持 + 单双混用各自成对', () => {
    expect(parseValue('["A,B", C]')).toEqual(['A,B', 'C'])
    expect(parseValue("['A,B', \"C,D\"]")).toEqual(['A,B', 'C,D'])
  })

  it('引号外普通逗号照切（既有行为）', () => {
    expect(splitInlineArray('悬疑, 推理, 恐怖')).toEqual(['悬疑', '推理', '恐怖'])
  })
})
