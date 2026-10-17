/**
 * check:suppressions 直测——上限门的判据口径（超上限红 / 等量绿 / 形状坏红）。
 */
import { describe, expect, it } from 'vitest'
// @ts-expect-error —— .mjs 直跑脚本无类型声明（不为其维护 d.ts；断言口径靠用例锚定）。
import { inspectSuppressions, SUPPRESSION_BASELINE } from '../../scripts/check-suppressions.mjs'

describe('check:suppressions 上限门', () => {
  it('总量等于上限 → 通过；低于上限 → 通过', () => {
    expect(inspectSuppressions({ 'a.ts': { rule: { count: 2 } } }, 2).problems).toEqual([])
    expect(inspectSuppressions({ 'a.ts': { rule: { count: 1 } } }, 2).problems).toEqual([])
  })

  it('总量超过上限 → 红并点名只减不增', () => {
    const r = inspectSuppressions({ 'a.ts': { x: { count: 2 } }, 'b.ts': { y: { count: 2 } } }, 3)
    expect(r.total).toBe(4)
    expect(r.problems.join('\n')).toContain('只减不增')
  })

  it('台账形状坏（顶层非对象 / count 非正整数）→ 红', () => {
    expect(inspectSuppressions([], SUPPRESSION_BASELINE).problems.length).toBeGreaterThan(0)
    expect(inspectSuppressions({ 'a.ts': { x: { count: 0 } } }, SUPPRESSION_BASELINE).problems.length).toBeGreaterThan(
      0,
    )
  })

  it('当前仓库台账总量不超基线', () => {
    // 真实台账由 check:suppressions 直跑兜底；此处锁基线 = 台账实测总量（只减不增，
    // 下调台账时同步改基线，二者漂移即门红）
    expect(Number.isInteger(SUPPRESSION_BASELINE)).toBe(true)
    expect(SUPPRESSION_BASELINE).toBe(315)
  })
})
