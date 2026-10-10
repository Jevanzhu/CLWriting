/**
 * 三审视角清单固化（知识层接入批）：六视角 + 通用 fallback 的 system prompt 必须带
 * 判断类核对项（抽出窗口 = 知识层速查 → resources/prompts/review-*.md 固化）。
 *
 * 与金测（prompt-golden）互补：金测锁「文本与夹具字节等价」（改文本须显式同步夹具），
 * 本组锁「固化内容在位」——把某条技法从 prompt 里摘掉即红，不依赖夹具同步动作。
 * 通用一条进全部 7 个文件（视角 prompt 自包含，不复用 common 文本）。
 */
import { describe, it, expect } from 'vitest'
import { REVIEW_SYSTEMS, REVIEW_COMMON } from '../../src/ai/prompts/review.js'

const ALL = ['reader', 'editor', 'continuity', 'hook', 'emotion_peak', 'payoff'] as const
const ALL_TEXTS: Array<[string, string]> = [
  ['review-common', REVIEW_COMMON],
  ...ALL.map((lens) => [`review-${lens}`, REVIEW_SYSTEMS[lens]!] as [string, string]),
]

describe('三审视角清单固化：通用章级判断条（全 7 文件）', () => {
  it('每个视角 prompt 与 common 都含章级判断核对（水章/信息跟冲突/情绪落地/结尾变化）', () => {
    for (const [name, text] of ALL_TEXTS) {
      expect(text, name).toContain('章级判断（逐条核对）')
      expect(text, name).toContain('删掉无影响 ＝ 水章')
      expect(text, name).toContain('总结式结尾即问题')
    }
  })
})

describe('三审视角清单固化：按视角对口的判断类技法', () => {
  it('hook：章尾钩子手法枚举（八式）与「钩子不替代推进」', () => {
    expect(REVIEW_SYSTEMS['hook']).toContain('章尾钩子')
    expect(REVIEW_SYSTEMS['hook']).toContain('回声 / 留白')
    expect(REVIEW_SYSTEMS['hook']).toContain('钩子不替代推进')
  })

  it('emotion_peak：反转机制核对（埋线 ≥2-3 处 / 误导 / 一次性揭示 / 揭示后兑现）', () => {
    const t = REVIEW_SYSTEMS['emotion_peak']!
    expect(t).toContain('埋线是否 ≥2-3 处')
    expect(t).toContain('挤牙膏')
    expect(t).toContain('揭示后是否立刻有情绪兑现')
  })

  it('payoff：打脸铺垫优先、分层与兑现具体性', () => {
    const t = REVIEW_SYSTEMS['payoff']!
    expect(t).toContain('铺垫比打脸重要')
    expect(t).toContain('打脸是否分层')
    expect(t).toContain('靠旁白宣告产 issue')
  })

  it('reader：升级感三步 + 期待值口径 + 看点/爽点分工', () => {
    const t = REVIEW_SYSTEMS['reader']!
    expect(t).toContain('升级感三步')
    expect(t).toContain('期待值 ＝ 价值 × 可能性')
    expect(t).toContain('看点吊期待、爽点满足期待')
  })

  it('editor：对话质量四问与人物活人度（工具人/纯恶反派）', () => {
    const t = REVIEW_SYSTEMS['editor']!
    expect(t).toContain('对话质量')
    expect(t).toContain('潜台词（说的不是想的）')
    expect(t).toContain('只有功能 ＝ 工具人')
  })

  it('continuity：连载连续性四条与关系网事件驱动', () => {
    const t = REVIEW_SYSTEMS['continuity']!
    expect(t).toContain('连载连续性')
    expect(t).toContain('故事引擎是否仍在运转')
    expect(t).toContain('关系变化是否有事件驱动')
  })
})
