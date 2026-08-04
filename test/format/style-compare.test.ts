/**
 * 文风比对层单测（文风系统重整 S3）：n-gram / 词级差极大化 / Jaccard 分层 / 段落配对。
 */
import { describe, it, expect } from 'vitest'
import {
  charNgrams,
  missingNgrams,
  similarity,
  tierOf,
  compareVersions,
} from '../../src/format/style-compare.js'

describe('charNgrams', () => {
  it('中文 bigram；标点切分不产跨句碎片', () => {
    expect(charNgrams('他说你好', 2)).toEqual(new Set(['他说', '说你', '你好']))
    // 句号切成两个 run，无跨句「说你」
    expect(charNgrams('他说。你好', 2)).toEqual(new Set(['他说', '你好']))
  })

  it('短 run 以全体入集（单字不因空集误判）', () => {
    expect(charNgrams('好', 2)).toEqual(new Set(['好']))
    expect(similarity('好', '坏')).toBe(0)
  })
})

describe('similarity / tierOf', () => {
  it('相同=1；全异=0；两空=1；一空一非空=0', () => {
    expect(similarity('夜色沉沉，他往上走。', '夜色沉沉，他往上走。')).toBe(1)
    expect(similarity('夜色沉沉', '晨光熹微')).toBe(0)
    expect(similarity('', '')).toBe(1)
    expect(similarity('', '夜色沉沉')).toBe(0)
  })

  it('部分重叠落中间值', () => {
    const s = similarity('他推开大门走进院子', '他推开大门离开院子')
    expect(s).toBeGreaterThan(0)
    expect(s).toBeLessThan(1)
  })

  it('分层边界：>95% 已对齐 / 70–95% 表层 / <70% 缺口', () => {
    expect(tierOf(0.96)).toBe('aligned')
    expect(tierOf(0.95)).toBe('surface')
    expect(tierOf(0.7)).toBe('surface')
    expect(tierOf(0.699)).toBe('gap')
  })
})

describe('missingNgrams', () => {
  it('AI 独有短语浮出且极大化去碎片；作者保留词不出现', () => {
    const ai = '他深吸一口气，看向远方。'
    const author = '他顿了顿，看向远方。'
    const missing = missingNgrams(ai, author)
    expect(missing).toContain('深吸一口气')
    expect(missing).not.toContain('深吸') // 被更长缺失项覆盖
    expect(missing).not.toContain('看向远方') // 作者版保留
  })

  it('完全相同文本无缺失', () => {
    expect(missingNgrams('缓缓抬起头。', '缓缓抬起头。')).toEqual([])
  })
})

describe('compareVersions', () => {
  // 段1 原样保留（aligned）；段2 只删「深吸一口气」微调（surface）；段3 完全重写（gap）
  const P1 = '夜色沉沉，山门外的石阶爬满青苔，他提着灯一步步往上走。'
  const P2_AI =
    '他深吸一口气，推开大门。院子里静得出奇，落叶铺了一地，墙角的灯笼在风里轻轻摇晃，映出一圈昏黄的光。他放轻脚步，沿着回廊往里走，每一步都踩在自己的心跳上。'
  const P2_AU =
    '他顿了顿，推开大门。院子里静得出奇，落叶铺了一地，墙角的灯笼在风里轻轻摇晃，映出一圈昏黄的光。他放轻脚步，沿着回廊往里走，每一步都踩在自己的心跳上。'
  const P3_AI = '远处传来钟声，惊起一群飞鸟。'
  const P3_AU = '守夜人敲了三下梆子，更声在巷子深处荡开。'

  const aiText = [P1, P2_AI, P3_AI].join('\n\n')
  const auText = [P1, P2_AU, P3_AU].join('\n\n')

  it('段落配对正确 + 三层分层', () => {
    const r = compareVersions(aiText, auText)
    expect(r.paras).toHaveLength(3)
    expect(r.paras[0]!.tier).toBe('aligned')
    expect(r.paras[0]!.aiPara).toBe(P1)
    expect(r.paras[0]!.sim).toBe(1)
    expect(r.paras[1]!.tier).toBe('surface')
    expect(r.paras[1]!.aiPara).toBe(P2_AI)
    expect(r.paras[2]!.tier).toBe('gap')
    expect(r.overallSim).toBeGreaterThan(0)
    expect(r.overallSim).toBeLessThan(1)
  })

  it('词级信号只来自 surface 段：微调删词浮出，gap 段 AI 独有词不混入', () => {
    const r = compareVersions(aiText, auText)
    expect(r.missing.some((g) => g.includes('深吸'))).toBe(true)
    expect(r.missing.every((g) => !g.includes('惊起'))).toBe(true) // 段3 gap，不供词级
  })

  it('作者新增段（AI 版无对应）→ aiPara null + gap', () => {
    const added = '灶上的粥早就凉透了，她却一直没动。'
    const r = compareVersions(aiText, [P1, P2_AU, P3_AU, added].join('\n\n'))
    expect(r.paras).toHaveLength(4)
    const last = r.paras[3]!
    expect(last.authorPara).toBe(added)
    expect(last.aiPara).toBeNull()
    expect(last.sim).toBe(0)
    expect(last.tier).toBe('gap')
  })

  it('空 AI 版（纯手写场景防御）：所有作者段 gap，无词级信号', () => {
    const r = compareVersions('', auText)
    expect(r.paras.every((p) => p.aiPara === null && p.tier === 'gap')).toBe(true)
    expect(r.missing).toEqual([])
  })
})
