/**
 * 长篇叙事机制两视角（信息披露审 / 情节与因果审）单测。
 *
 * 锚定对外可观察面：任务书条件化（长篇恒跑、短篇不产）、机检信息差候选只进信息披露审、
 * 两视角的对口技法篇与 prompt 文案在位（视角自证：模型按 prompt 审，判据不在就无从审）。
 * 此处不测「真模型会怎么判」——那归三审回收链（run.test.ts）。
 */
import { describe, it, expect } from 'vitest'
import { buildReviewTasks, type ReviewLens } from '../../src/review/contract.js'
import { buildReviewMethodInjection } from '../../src/knowledge/review-method.js'
import { REVIEW_SYSTEMS } from '../../src/ai/prompts/review.js'
import { LONG_FILE_OUTLINE, LONG_FILE_SUSPENSE } from '../../src/knowledge/catalog.js'
import type { CheckReport } from '../../src/check/types.js'

const emptyReport: CheckReport = { sections: [], byproducts: {} }

function lensOf(report: CheckReport, opts: { hasWiring: boolean; hasShort: boolean }) {
  return buildReviewTasks(report, opts).map((t) => t.lens)
}

describe('叙事机制两视角：任务书条件化', () => {
  it('长篇恒跑（有布线 / 无布线都在场）——判据在章内可判，不由布线有无辖制', () => {
    for (const hasWiring of [true, false]) {
      const lenses = lensOf(emptyReport, { hasWiring, hasShort: false })
      expect(lenses, `hasWiring=${hasWiring}`).toContain('disclosure')
      expect(lenses, `hasWiring=${hasWiring}`).toContain('plot_causality')
    }
  })

  it('短篇不产——长程判据（跨章信息差编排 / 单元间因果）在单篇闭口语境不成立', () => {
    const lenses = lensOf(emptyReport, { hasWiring: true, hasShort: true })
    expect(lenses).not.toContain('disclosure')
    expect(lenses).not.toContain('plot_causality')
    // 短篇视角照常在场（未被误删）
    expect(lenses).toContain('payoff')
  })

  it('两视角 must_run 恒 true（满审不被降级稀释）', () => {
    const tasks = buildReviewTasks(emptyReport, { hasWiring: false, hasShort: false })
    for (const lens of ['disclosure', 'plot_causality'] as ReviewLens[]) {
      expect(tasks.find((t) => t.lens === lens)!.must_run, lens).toBe(true)
    }
  })
})

describe('信息披露审：机检候选对接', () => {
  it('byproducts.infoLeakCandidates → 只进 disclosure（其余视角不带）', () => {
    const report: CheckReport = { sections: [], byproducts: { infoLeakCandidates: ['身世之谜'] } }
    const tasks = buildReviewTasks(report, { hasWiring: true, hasShort: false })
    expect(tasks.find((t) => t.lens === 'disclosure')!.leak_candidates).toEqual(['身世之谜'])
    for (const t of tasks) {
      if (t.lens === 'disclosure') continue
      expect(t.leak_candidates, t.lens).toBeUndefined()
    }
  })

  it('无候选（未配信息差词表）→ 空数组，不阻断该视角', () => {
    const d = buildReviewTasks(emptyReport, { hasWiring: false, hasShort: false }).find((t) => t.lens === 'disclosure')!
    expect(d.leak_candidates).toEqual([])
  })
})

describe('叙事机制两视角：对口技法篇', () => {
  it.each([
    ['disclosure', LONG_FILE_SUSPENSE, '信息差'],
    ['plot_causality', LONG_FILE_OUTLINE, '因果'],
  ])('%s → 对口篇注入且登记名走内置前缀', (lens, file, marker) => {
    const inj = buildReviewMethodInjection(lens)
    expect(inj.text).toContain(marker)
    expect(inj.sources).toEqual([`知识层(内置)/${file}`])
  })

  it('短篇档不映射两视角（空段：不在短篇任务书里，不虚报技法）', () => {
    for (const lens of ['disclosure', 'plot_causality']) {
      const inj = buildReviewMethodInjection(lens, undefined, undefined, 'short')
      expect(inj.text, lens).toBe('')
      expect(inj.sources, lens).toEqual([])
    }
  })
})

describe('叙事机制两视角：prompt 判据在位', () => {
  it('信息披露审：四批判据 + 三步按序', () => {
    const text = REVIEW_SYSTEMS['disclosure']!
    for (const k of ['信号', '核实', '判断', '信息跟着冲突走', '角色已知边界', '谜语人']) {
      expect(text, k).toContain(k)
    }
    // 机检只出候选、真伪归本视角——口径必须写进 prompt
    expect(text).toContain('真伪归本视角')
  })

  it('情节与因果审：五批判据 + 三步按序', () => {
    const text = REVIEW_SYSTEMS['plot_causality']!
    for (const k of [
      '信号',
      '核实',
      '判断',
      '因果链闭合',
      '转折成立',
      '人物动机支撑行动',
      '主线因果不漂移',
      '后果落地',
    ]) {
      expect(text, k).toContain(k)
    }
    expect(text).toContain('时间串联')
  })

  it('两视角的 category 指向回收白名单内的枚举', () => {
    expect(REVIEW_SYSTEMS['disclosure']).toContain('disclosure（信息披露）')
    expect(REVIEW_SYSTEMS['plot_causality']).toContain('causality（因果）')
  })
})
