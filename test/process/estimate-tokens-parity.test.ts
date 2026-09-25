/**
 * R0916-7-P3-3（2026-09-16 评审修复批）：estimateTokens 新家导出面直测。
 *
 * 被测行为：token 粗估的**口径与迁移前逐位一致**（原 process/prepare.ts 实现整体随迁
 * shared/tokens.ts，无兼容层）——默认系数 0.6、按模型查表且取**最长前缀**命中、未知
 * 模型/无模型回落兜底、长度按码位（增补平面一符一码位）计、向上取整。
 * 表驱动几档模型（默认 / 前缀命中族 / 未知模型 / 无模型）钉住系数来源。
 */
import { describe, expect, it } from 'vitest'
import { DEFAULT_TOKEN_COEFF, TOKEN_COEFFICIENTS, estimateTokens } from '../../src/shared/tokens.js'

/** 码位计数口径（迁移前由 process/prepare 转调的同一实现：shared/text.ts）。 */
const cps = (s: string): number => Array.from(s).length

describe('shared/tokens：estimateTokens 导出面（R0916-7-P3-3）', () => {
  it('空串 0；中文按 0.6 兜底系数向上取整（10 字 → ceil(6.0)=6）', () => {
    expect(estimateTokens('')).toBe(0)
    expect(cps('一二三四五六七八九十')).toBe(10)
    expect(estimateTokens('一二三四五六七八九十')).toBe(Math.ceil(10 * DEFAULT_TOKEN_COEFF))
    expect(estimateTokens('一二三四五六七八九十')).toBe(6)
  })

  it('长度按码位：10 个 emoji（20 码元）= 10 码位 → 6（与迁移前同口径）', () => {
    const emoji = '😀'.repeat(10)
    expect(emoji.length).toBe(20)
    expect(estimateTokens(emoji)).toBe(Math.ceil(10 * DEFAULT_TOKEN_COEFF))
    expect(estimateTokens(emoji)).toBe(6)
  })

  it('表驱动：最长前缀命中 / 次长前缀 / 未知模型与无模型回落兜底', () => {
    TOKEN_COEFFICIENTS['p3-3-sonnet'] = 0.5
    TOKEN_COEFFICIENTS['p3-3-sonnet-4'] = 0.4
    try {
      const cases: Array<{ model?: string; coeff: number; note: string }> = [
        { model: 'p3-3-sonnet-4-5', coeff: 0.4, note: '最长前缀 p3-3-sonnet-4 命中' },
        { model: 'p3-3-sonnet-3', coeff: 0.5, note: '退到较短前缀 p3-3-sonnet' },
        { model: 'p3-3-unknown-x', coeff: DEFAULT_TOKEN_COEFF, note: '未知模型回落兜底' },
        { model: undefined, coeff: DEFAULT_TOKEN_COEFF, note: '不传模型回落兜底' },
      ]
      for (const c of cases) {
        const text = 'abcd'
        expect(estimateTokens(text, c.model), c.note).toBe(Math.ceil(cps(text) * c.coeff))
      }
    } finally {
      delete TOKEN_COEFFICIENTS['p3-3-sonnet']
      delete TOKEN_COEFFICIENTS['p3-3-sonnet-4']
    }
  })

  it('迁移后无 re-export 双轨：estimateTokens 不再自 process/prepare 导出（同一模块对象）', async () => {
    const prepare = await import('../../src/process/prepare.js')
    expect('estimateTokens' in prepare).toBe(false)
    expect('TOKEN_COEFFICIENTS' in prepare).toBe(false)
    expect('DEFAULT_TOKEN_COEFF' in prepare).toBe(false)
    // 消费方（适配器族用量估算）与备料预算闸读同一份系数表/函数
    const usageEstimate = await import('../../src/ai/provider/usage-estimate.js')
    expect(usageEstimate.estimateOutputTokens('abcd', undefined)).toBe(estimateTokens('abcd'))
  })
})
