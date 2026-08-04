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
      expect(hit).toBeDefined()
      expect(hit!.ruleId).toBe('style-consistency')
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
      expect(hit).toBeDefined()
      // message 应含证据关键词和具体词组（非静态建议）
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
      expect(hit).toBeDefined()
      // message 应含总结句原文（非静态建议）
      expect(hit!.message).toContain('总之')
      expect(hit!.message).toContain('删去段末总结句')
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
