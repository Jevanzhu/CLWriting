// @vitest-environment happy-dom
/**
 * R73-69（批 F-2）：parseNumericInput 全分支直测（此前零直测）。
 *
 * 该 helper 刚经历 R72-11 空串 clamp 缺陷修复（`Number('') === 0` 能穿过 isFinite 闸、
 * 被 setter clamp 静默钳成下限）——却没有任何直测锚定修复语义。本文件用真实 input
 * 元素派发 change 事件驱动解析，锚定：空串/全空白 → null、非数/Infinity → null、
 * 正常值（含负数/小数/科学计数/十六进制）透传 Number 语义。
 *
 * 现状锚（非建议）：本函数不做范围钳制——「越界值」也原样返回，clamp 责任在
 * 调用方 setter（设置页各 store）；若未来把 clamp 下沉进本函数，属行为变更须改用例。
 */
import { describe, it, expect } from 'vitest'
import { parseNumericInput } from '../../../src/studio/web-next/src/shared/numeric-input'

/** 造一个带值的 input 并派发 change 事件，返回 parseNumericInput 的结果 */
function parseVia(raw: string): number | null {
  const input = document.createElement('input')
  input.value = raw
  let out: number | null = null
  input.addEventListener('change', (e) => {
    out = parseNumericInput(e)
  })
  input.dispatchEvent(new Event('change'))
  return out
}

describe('R73-69：parseNumericInput（R72-11 空串缺陷回归锚）', () => {
  it('空串/全空白 → null（不得落成 0 被 clamp 成下限——R72-11 缺陷即红）', () => {
    expect(parseVia('')).toBeNull()
    expect(parseVia('   ')).toBeNull() // trim 后为空同口径
    expect(parseVia('\t')).toBeNull()
  })

  it('非数/无穷 → null（NaN 与 Infinity 均不过 isFinite 闸）', () => {
    expect(parseVia('abc')).toBeNull()
    expect(parseVia('12px')).toBeNull()
    expect(parseVia('-')).toBeNull()
    expect(parseVia('1e309')).toBeNull() // Number('1e309') = Infinity
    expect(parseVia('-Infinity')).toBeNull()
  })

  it('正常值透传：整数/负数/小数/前后空白', () => {
    expect(parseVia('42')).toBe(42)
    expect(parseVia('0')).toBe(0)
    expect(parseVia('-3.5')).toBe(-3.5)
    expect(parseVia(' 2.75 ')).toBe(2.75) // trim 后可解析
  })

  it('Number 语义宽容形态原样透传（现状锚：不额外收紧词法）', () => {
    expect(parseVia('1e2')).toBe(100)
    expect(parseVia('0x10')).toBe(16)
  })

  it('不做范围钳制：超大/超小合法数字原样返回（clamp 责任在调用方 setter）', () => {
    expect(parseVia('999999999')).toBe(999999999)
    expect(parseVia('-999999999')).toBe(-999999999)
  })
})
