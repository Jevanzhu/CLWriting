/**
 * learn-tier tierOf 直测（R73-81）：文风收割打分分档——A ≥90 优质 / B 75-89 良好 /
 * C <75 及格。与 src/format/style-compare.ts 的同名 tierOf（相似度分层）仅重名、
 * 无关联；本实现此前零直测（learn-store.test.ts 只走 store 链路）。
 */
import { describe, expect, it } from 'vitest'
import { TIER_A, tierOf } from '../../../src/studio/web-next/src/shared/learn-tier'

describe('tierOf 打分分档（R73-81）', () => {
  it('A 档下界：恰 TIER_A(90) 与以上 → a', () => {
    expect(TIER_A).toBe(90) // 锚定常量即下界实现（上游改常量此处先红）
    expect(tierOf(90)).toBe('a')
    expect(tierOf(100)).toBe('a')
  })

  it('A/B 边界：90 以下即 b（89 不进 A）', () => {
    expect(tierOf(89)).toBe('b')
    expect(tierOf(89.9)).toBe('b')
  })

  it('B 档下界：恰 75 → b', () => {
    expect(tierOf(75)).toBe('b')
  })

  it('B/C 边界：75 以下即 c（74 不进 B）', () => {
    expect(tierOf(74.9)).toBe('c')
    expect(tierOf(74)).toBe('c')
  })

  it('C 档覆盖 0 分', () => {
    expect(tierOf(0)).toBe('c')
  })

  it('空/异常分值兜底 → c（NaN/undefined 不满足任何下档阈值）', () => {
    expect(tierOf(NaN)).toBe('c')
    expect(tierOf(undefined as unknown as number)).toBe('c')
  })
})
