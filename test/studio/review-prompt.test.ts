/**
 * buildLensPrompt 渲染契约单测（w 轮 批1：W-P1-2 + W-P2-13）。
 * 内核 buildReviewPacket 恒给 payoff 任务带 list_checks（反转线索表+伏笔回收），
 * API 层 prompt 必须渲染出来（与 continuity 账本核对对称）；category 枚举须含短篇四类
 * （与内核回收白名单 CATEGORIES 一致，否则短篇模型产出命中率被系统性压低）。
 */
import { describe, it, expect } from 'vitest'
import { buildLensPrompt } from '../../src/studio/server/api/review.js'

const BASE = { lens: 'payoff', title: '设定收尾审', focus: ['反转线索表清单核对'] } satisfies {
  lens: 'payoff'
  title: string
  focus: string[]
}

describe('buildLensPrompt（W-P1-2 清单核对 / W-P2-13 枚举）', () => {
  it('payoff + list_checks → 渲染清单条目（反转/伏笔逐条）', () => {
    const p = buildLensPrompt(
      'payoff',
      {
        ...BASE,
        ledger_checks: [],
        list_checks: [
          { type: 'reversal', subject: '师父是仇人', location: '第3段', detail: '玉佩裂纹与仇人剑纹一致' },
          { type: 'payoff', subject: '断剑伏笔', location: '', detail: '结尾未回收' },
        ],
      },
      '正文内容。',
      1,
    )
    expect(p).toContain('## 清单核对(逐条核对反转线索与伏笔回收)')
    expect(p).toContain('- 反转｜师父是仇人｜第3段｜玉佩裂纹与仇人剑纹一致')
    expect(p).toContain('- 伏笔｜断剑伏笔｜未标注位置｜结尾未回收')
  })

  it('payoff 无 list_checks → 占位说明，不渲染空清单', () => {
    const p = buildLensPrompt('payoff', { ...BASE, ledger_checks: [] }, '正文。', 2)
    expect(p).toContain('## 清单核对\n(本篇无清单条目)')
  })

  it('continuity 账本核对渲染不回归', () => {
    const p = buildLensPrompt(
      'continuity',
      {
        lens: 'continuity',
        title: '设定校对',
        focus: [],
        ledger_checks: [{ lead_id: '玉佩', chapter: 1, verb: '获得', evidence: '主角拾得玉佩' }],
      },
      '正文。',
      1,
    )
    expect(p).toContain('## 账本核对(逐条核对账实相符)')
    expect(p).toContain('- 玉佩 第1章 获得:主角拾得玉佩')
    expect(p).not.toContain('清单核对')
  })

  it('category 枚举含短篇四类（与内核回收白名单一致）', () => {
    const p = buildLensPrompt('hook', { lens: 'hook', title: '钩子审', focus: [], ledger_checks: [] }, '正文。', 1)
    for (const c of ['hook(开篇钩子)', 'emotion_peak(情绪反转)', 'reversal(反转线索)', 'payoff(伏笔回收)']) {
      expect(p).toContain(c)
    }
    // 长篇 12 类不丢
    expect(p).toContain('high_point(爽点)')
    expect(p).toContain('safety(安全红线)')
  })
})
