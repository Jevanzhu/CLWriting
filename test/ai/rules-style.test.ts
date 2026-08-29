/**
 * A3 风格一致规则单测。
 *
 * 覆盖：
 * 1. 无基线 → toPrompt 返回 null（临时目录无 文风/基线.json）
 * 2. 无基线 → check 返回空数组
 * 3. 有基线 → toPrompt 返回含「文风一致」的约束
 * 4. 有基线 + 正文偏离某维超 40% → check 报黄
 * 5. 有基线 + 正文贴近基线 → check 返回空数组
 *
 * 测试自包含，mkdtempSync 造临时目录，rmSync 清理。
 * 基线 fixture 写 文风/基线.json；铁律 fixture 写 文风/文风铁律.md（最小内容）。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { styleConsistencyRule } from '../../src/ai/rules/style-rule.js'
import { computeFullStats, readIronRules, type FullStyleStats } from '../../src/metrics/style.js'
import { extractRepeatPhrases, extractLongSentences, extractSummaryEnding } from '../../src/ai/rules/style-remedy.js'

/** 写基线 fixture 到临时书库根的 文风/基线.json */
function writeBaseline(root: string, overall: FullStyleStats): void {
  mkdirSync(join(root, '文风'), { recursive: true })
  writeFileSync(
    join(root, '文风', '基线.json'),
    JSON.stringify(
      {
        version: 1,
        frozenAt: '2026-01-01T00:00:00.000Z',
        frozenFrom: 'test-fixture',
        byScene: {},
        overall,
      },
      null,
      2,
    ),
    'utf-8',
  )
}

/** 造一个全零基线指纹（多数维度为 0，仅 sentenceLenVariance 可调） */
function zeroStats(sentenceLenVariance = 0): FullStyleStats {
  return {
    overlongRatio: 0,
    adjStackHits: 0,
    dialogueTagRatio: 0,
    parallelStreakMax: 0,
    summaryEnding: false,
    _dialogueLines: 0,
    sentenceLenVariance,
    repeatRate: 0,
  }
}

describe('A3 风格一致规则', () => {
  describe('无基线', () => {
    it('toPrompt 返回 null（临时目录无 文风/基线.json）', () => {
      const root = mkdtempSync(join(tmpdir(), 'clwriting-style-nobase-'))
      try {
        expect(styleConsistencyRule.toPrompt({ bookRoot: root })).toBeNull()
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    })

    it('check 返回空数组', () => {
      const root = mkdtempSync(join(tmpdir(), 'clwriting-style-nobase-'))
      try {
        expect(styleConsistencyRule.check('一段普通正文', { bookRoot: root })).toEqual([])
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    })
  })

  describe('有基线', () => {
    let bookRoot: string

    beforeAll(() => {
      bookRoot = mkdtempSync(join(tmpdir(), 'clwriting-style-'))
      mkdirSync(join(bookRoot, '文风'), { recursive: true })
      // 最小铁律文件（仅有标题 → parseIronRules 返回空 IronRules）
      writeFileSync(join(bookRoot, '文风', '文风铁律.md'), '# 文风铁律\n', 'utf-8')
    })

    afterAll(() => {
      if (bookRoot) rmSync(bookRoot, { recursive: true, force: true })
    })

    it('toPrompt 返回含「文风一致」的约束', () => {
      writeBaseline(bookRoot, zeroStats(10))
      const text = styleConsistencyRule.toPrompt({ bookRoot })
      expect(text).toContain('文风一致')
    })

    it('正文偏离某维超 40% 时 check 报黄（句长方差远超基线）', () => {
      // 基线 sentenceLenVariance = 1.0；正文一字句 + 长句 → 方差远超 1.0
      writeBaseline(bookRoot, zeroStats(1.0))
      const body = '一。这是一个非常非常非常非常非常非常非常非常非常非常长的句子。'
      const violations = styleConsistencyRule.check(body, { bookRoot })
      const hit = violations.find((v) => v.message.includes('句长方差'))
      expect(hit).toEqual(expect.objectContaining({ ruleId: 'style-consistency', level: 'yellow' }))
      expect(hit!.level).toBe('yellow')
      expect(hit!.message).toContain('偏离基线')
      expect(hit!.message).toContain('偏高')
    })

    it('正文贴近基线时 check 返回空数组（自洽基线：正文实际 stats 写入基线）', () => {
      // 自洽基线：先用正文算实际 stats 再写进基线 → check 时偏离 = 0
      const body = '他推开门走进房间。桌上摆着一杯凉掉的茶。窗外下着小雨。'
      const stats = computeFullStats(body, readIronRules(bookRoot))
      writeBaseline(bookRoot, stats)
      const violations = styleConsistencyRule.check(body, { bookRoot })
      expect(violations).toEqual([])
    })

    it('复读率偏离时 check message 含重复词组证据', () => {
      // 基线 repeatRate=0；正文有整句重复 → 复读率偏离超 40%
      writeBaseline(bookRoot, zeroStats(10))
      const body = '他推开门走进房间。桌上摆着一杯凉茶。他推开门走进房间。'
      const violations = styleConsistencyRule.check(body, { bookRoot })
      const hit = violations.find((v) => v.message.includes('复读率'))
      expect(hit).toEqual(expect.objectContaining({ ruleId: 'style-consistency', level: 'yellow' }))
      expect(hit!.message).toContain('重复出现')
      expect(hit!.message).toContain('他推开门')
    })

    it('结尾总结体命中时 check message 含总结句原文', () => {
      // 铁律需设 avoidSummaryEnding 才会检测 summaryEnding
      writeFileSync(join(bookRoot, '文风', '文风铁律.md'), '# 文风铁律\n\n结尾总结体: 禁止\n', 'utf-8')
      // 基线 summaryEnding=false；正文末段含总结词（同时匹配 summaryEndingRegex 的套路词）
      writeBaseline(bookRoot, zeroStats(10))
      const body = '他推开门走进房间。桌上摆着一杯凉茶。\n\n总之，这一刻他终于明白了命运的真谛。'
      const violations = styleConsistencyRule.check(body, { bookRoot })
      const hit = violations.find((v) => v.message.includes('结尾总结体'))
      expect(hit).toEqual(expect.objectContaining({ ruleId: 'style-consistency' }))
      expect(hit!.message).toContain('总之')
      expect(hit!.message).toContain('删去段末总结句')
    })
  })

  // ── R75-1（批 A）：计数维量纲错配回归 ─────────────────
  // overall 基线 = 全部样章 join('\n\n') 的拼接语料指纹；本组回归保证：
  // 计数维（形容词堆叠）按千字密度比较后，单章 vs ≥2 条样章的拼接基线不再
  // 稳定产出「偏低」假黄；极值维（排比连续度）只保偏高侧；旧基线缺 charCount
  // 降级跳过计数维；两侧真偏离仍能报。
  describe('R75-1 计数维量纲（拼接语料基线 vs 单章）', () => {
    /** 造独立书根 + 计数维铁律（形容词堆叠≥3 单元计数、排比连续数启用） */
    function mkCountBook(): string {
      const root = mkdtempSync(join(tmpdir(), 'clwriting-style-r75-'))
      mkdirSync(join(root, '文风'), { recursive: true })
      writeFileSync(join(root, '文风', '文风铁律.md'), '# 文风铁律\n\n形容词连续堆叠上限: 2\n排比连续数: 3\n', 'utf-8')
      return root
    }

    /** 4 条等长样章：每条恰 1 处互不相同的形容词堆叠（maxAdjStack=2 → ≥3 个「X的」单元）；
     *  样章 2 另含 4 连排比（推高语料 parallelStreakMax），单章各自无长排比 */
    const SAMPLES = [
      '夜色沉下来。风把帘子掀起一角。苍白的干裂的颤抖的手指扣住窗棂。远处传来更声，他叹了口气。',
      '雨停了。檐角还在滴水。冰冷的坚硬的锐利的石阶泛着光。月光如水。月光如银。月光如纱。月光如泓。他收伞进门。',
      '炉火将熄。灰烬里还有一点红。潮湿的霉烂的腐朽的气味漫出来。老人裹紧了毯子，没有说话。',
      '马蹄声远了。官道重新安静下来。温热的柔软的昏沉的风从麦田那头吹过。少年勒住缰绳回头看。',
    ]

    /** 拼接语料（与 freezeBaseline 的 overall 同口径：join('\n\n')） */
    const CORPUS = SAMPLES.join('\n\n')

    /** 写新式基线（= freezeBaseline 产物形状：computeFullStats 含 charCount 因子） */
    function freezeNewStyle(root: string): void {
      writeBaseline(root, computeFullStats(CORPUS, readIronRules(root)))
    }

    /** 写旧式基线（v1 冻结于 charCount 引入前：剥掉该字段） */
    function freezeLegacy(root: string): void {
      const overall = { ...computeFullStats(CORPUS, readIronRules(root)) }
      delete overall.charCount
      writeBaseline(root, overall)
    }

    it('≥2 条样章的拼接基线 + 单章正文 → 不再产出「形容词堆叠 偏低」假黄（密度口径）', () => {
      const root = mkCountBook()
      try {
        freezeNewStyle(root)
        // 修复前：单章 hits=1 vs 语料 hits=4 → 偏低 75% 稳定假黄；密度口径下 1/len ≈ 4/(4len) 偏离≈0
        const violations = styleConsistencyRule.check(SAMPLES[0]!, { bookRoot: root })
        expect(violations.find((v) => v.message.includes('形容词堆叠'))).toBeUndefined()
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    })

    it('单章 parallelStreakMax 低于语料极值 → 不再产出「排比连续度 偏低」假黄（只保偏高侧）', () => {
      const root = mkCountBook()
      try {
        freezeNewStyle(root)
        // 语料 max=4（样章 2 的月光排比）；被检单章 max≤2——修复前 2/4=50% 偏低假黄
        const violations = styleConsistencyRule.check(SAMPLES[0]!, { bookRoot: root })
        expect(violations.find((v) => v.message.includes('排比连续度'))).toBeUndefined()
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    })

    it('真偏离·偏高：正文形容词堆叠密度远超基线 → 仍报黄且 message 用次/千字口径', () => {
      const root = mkCountBook()
      try {
        // 基线密度≈1 次/千章长；正文短而堆叠密集（3 处互不相同）→ 密度偏高远超 40%
        freezeNewStyle(root)
        const body = '苍白的干裂的颤抖的手。冰冷的坚硬的锐利的石头。潮湿的霉烂的腐朽的气味。'
        const violations = styleConsistencyRule.check(body, { bookRoot: root })
        const hit = violations.find((v) => v.message.includes('形容词堆叠'))
        expect(hit).toBeDefined()
        expect(hit!.message).toContain('偏高')
        expect(hit!.message).toContain('次/千字')
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    })

    it('真偏离·偏低：正文形容词堆叠密度远低于基线（基线密集/正文干净）→ 仍报黄', () => {
      const root = mkCountBook()
      try {
        // 自洽密集基线：正文本身写入基线（密度≈36 次/千字），再检一条干净长正文 → 密度偏低
        const dense = '苍白的干裂的颤抖的手。冰冷的坚硬的锐利的石阶。潮湿的霉烂的腐朽的气味。温热的柔软的昏沉的风。'
        writeBaseline(root, computeFullStats(dense, readIronRules(root)))
        const clean = '他推开门走进房间。桌上摆着一杯凉掉的茶。窗外下着小雨。他把伞收好靠在门边，没有开灯。'
        const violations = styleConsistencyRule.check(clean, { bookRoot: root })
        const hit = violations.find((v) => v.message.includes('形容词堆叠'))
        expect(hit).toBeDefined()
        expect(hit!.message).toContain('偏低')
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    })

    it('真偏离·排比偏高：章 max 显著超语料 max → 仍报黄（偏高侧保留）', () => {
      const root = mkCountBook()
      try {
        freezeNewStyle(root) // 语料 max=4（样章 2 的月光排比）
        // 6 连「月光」同前缀排比 → 章 max=6 > 4×1.4 → 偏高 50% 报黄
        const body = '他推开门。月光如水。月光如银。月光如纱。月光如练。月光如泓。月光如潮。夜深了。'
        const violations = styleConsistencyRule.check(body, { bookRoot: root })
        const hit = violations.find((v) => v.message.includes('排比连续度'))
        expect(hit).toBeDefined()
        expect(hit!.message).toContain('偏高')
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    })

    it('旧 v1 基线（缺 charCount）→ 计数维降级跳过：单章不再假黄，重度堆叠也不比（宁缺毋假）', () => {
      const root = mkCountBook()
      try {
        freezeLegacy(root)
        // 低侧：修复前单章 hits=1 vs 语料 4 → 假黄；现在缺因子直接跳过
        const low = styleConsistencyRule.check(SAMPLES[0]!, { bookRoot: root })
        expect(low.find((v) => v.message.includes('形容词堆叠'))).toBeUndefined()
        // 高侧同样降级（不产生新假阳的代价：真偏离检出留给重新冻结基线）
        const heavy = '苍白的干裂的颤抖的手。冰冷的坚硬的锐利的石头。潮湿的霉烂的腐朽的气味。'
        const high = styleConsistencyRule.check(heavy, { bookRoot: root })
        expect(high.find((v) => v.message.includes('形容词堆叠'))).toBeUndefined()
        // 排比偏高侧不依赖 charCount，旧基线仍生效（6 连「月光」同前缀 vs 语料 max=4）
        const parallel = '他推开门。月光如水。月光如银。月光如纱。月光如练。月光如泓。月光如潮。夜深了。'
        const par = styleConsistencyRule.check(parallel, { bookRoot: root })
        expect(par.find((v) => v.message.includes('排比连续度'))).toBeDefined()
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    })
  })
})

// ── B1 证据提取函数单测 ────────────────────────────

describe('B1 风格证据提取', () => {
  describe('extractRepeatPhrases', () => {
    it('提取重复出现的 4 字词组（高频优先 + 子串去重）', () => {
      const phrases = extractRepeatPhrases('月光洒落。月光洒落。')
      // 「月光洒落」4 字频次 2 → 应排首位；其 2/3 字子串被去重
      expect(phrases[0]).toBe('月光洒落')
    })

    it('无重复 → 返回空数组', () => {
      expect(extractRepeatPhrases('一段独一的文字。')).toEqual([])
    })

    it('最多返回 5 个', () => {
      // 构造 6+ 个不同重复词组
      const body = '苹果香蕉葡萄西瓜。苹果香蕉葡萄西瓜。橘子柠檬芒果草莓。橘子柠檬芒果草莓。'
      const phrases = extractRepeatPhrases(body)
      expect(phrases.length).toBeLessThanOrEqual(5)
    })
  })

  describe('extractLongSentences', () => {
    it('提取超长句并截断到 30 字 + ……', () => {
      const long = '一'.repeat(50)
      const body = `短句。${long}。短句。`
      const result = extractLongSentences(body)
      expect(result.length).toBe(1)
      const first = result[0]!
      expect(first).toHaveLength(30 + 2) // 30 字 + '……'
      expect(first.endsWith('……')).toBe(true)
    })

    it('无超长句 → 返回空数组', () => {
      expect(extractLongSentences('短句。也很短。')).toEqual([])
    })

    it('自定义 maxLen', () => {
      // maxLen=3 → 超过 3 字的句子都算超长
      const result = extractLongSentences('一二三四五。', 3)
      expect(result).toHaveLength(1)
    })
  })

  describe('extractSummaryEnding', () => {
    it('末段含总结词 → 返回该句', () => {
      const body = '正文段落。\n\n总之，这一切不过是一场梦。'
      expect(extractSummaryEnding(body)).toBe('总之，这一切不过是一场梦')
    })

    it('无总结词 → 返回 null', () => {
      expect(extractSummaryEnding('普通结尾。没有任何总结。')).toBeNull()
    })

    it('截断超长总结句到 40 字 + ……', () => {
      const long = '总之' + '一'.repeat(50)
      const body = `正文。\n\n${long}。`
      const result = extractSummaryEnding(body)!
      expect(result).toHaveLength(40 + 2) // 40 字 + '……'
      expect(result.endsWith('……')).toBe(true)
    })
  })
})
