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
  })
})
