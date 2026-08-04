/**
 * A2 WritingRule 规则层单测。
 *
 * 覆盖四组：
 * 1. aiClicheRule（内置静态规则）—— toPrompt/check 行为
 * 2. rulesToPrompt（注入侧）—— task 过滤 + 约束拼接
 * 3. collectRuleViolations（检验侧）—— 汇总违规项
 * 4. loadAiFlavorRule（书级 AI味标签词）—— 条目库动态规则
 *
 * 测试自包含，不依赖外部书库；临时目录用 mkdtempSync 创建、rmSync 清理。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  aiClicheRule,
  rulesToPrompt,
  collectRuleViolations,
  loadAiFlavorRule,
} from '../../src/ai/rules/index.js'
import { addEntry, ENTRIES_DIR } from '../../src/format/style-entry.js'

describe('A2 WritingRule 规则层', () => {
  describe('aiClicheRule（内置静态规则）', () => {
    it('toPrompt 返回含「避免AI味」的约束文本（传 { bookRoot: "" }）', () => {
      // 内置静态规则忽略 ctx，传空 bookRoot 即可
      const text = aiClicheRule.toPrompt({ bookRoot: '' })
      expect(text).toContain('避免AI味')
    })

    it('check 对含「值得一提的是」的正文报 yellow 违规，message 含「删除或替换」', () => {
      const violations = aiClicheRule.check('正文里值得一提的是效果很好', { bookRoot: '' })
      expect(violations).toHaveLength(1)
      expect(violations[0]!.level).toBe('yellow')
      expect(violations[0]!.message).toContain('删除或替换')
    })

    it('check 对含「不禁」的正文报违规', () => {
      const violations = aiClicheRule.check('他不禁笑了', { bookRoot: '' })
      expect(violations).toHaveLength(1)
      expect(violations[0]!.ruleId).toBe('ai-cliche')
    })

    it('check 对干净正文（无套话词）返回空数组', () => {
      const violations = aiClicheRule.check('一段普通的描写，没有任何套话词', { bookRoot: '' })
      expect(violations).toHaveLength(0)
    })
  })

  describe('rulesToPrompt（注入侧）', () => {
    it("task='self-heal' 时返回含「避免AI味」的约束文本（bookRoot 传 undefined——内置静态规则不依赖 bookRoot）", () => {
      const text = rulesToPrompt('self-heal', undefined)
      expect(text).toContain('避免AI味')
    })

    it("task='rewrite' 时同样含约束", () => {
      const text = rulesToPrompt('rewrite', undefined)
      expect(text).toContain('避免AI味')
    })

    it("task='review' 时返回空串（审稿不挂载 ai-cliche 规则）", () => {
      // aiClicheRule.tasks = ['self-heal', 'spawn-write', 'rewrite']，不含 review
      const text = rulesToPrompt('review', undefined)
      expect(text).toBe('')
    })
  })

  describe('collectRuleViolations（检验侧）', () => {
    it('对含「值得一提的是」的正文检出违规，ruleId=\'ai-cliche\'，level=\'yellow\'', () => {
      // bookRoot 空串 → applicableRules 只返回内置静态规则（不读条目库）
      const violations = collectRuleViolations('值得一提的是效果很好', 'rewrite', '')
      const hit = violations.find((v) => v.ruleId === 'ai-cliche')
      expect(hit).toBeDefined()
      expect(hit!.level).toBe('yellow')
    })

    it('对干净正文返回空数组', () => {
      const violations = collectRuleViolations('一段普通正文，无套话', 'rewrite', '')
      expect(violations).toHaveLength(0)
    })
  })

  describe('loadAiFlavorRule（书级 AI味标签词）', () => {
    let bookRoot: string

    beforeAll(() => {
      // mkdtempSync 创建临时书库根
      bookRoot = mkdtempSync(join(tmpdir(), 'clwriting-rules-'))
      // 建条目库目录结构（ENTRIES_DIR = '文风/条目'），addEntry 内部亦会建，此处显式建确保路径就绪
      mkdirSync(join(bookRoot, ENTRIES_DIR, '禁词'), { recursive: true })
      // addEntry 写一条 AI味标签禁词（说明字段 = 修复建议）
      addEntry(bookRoot, {
        类型: '禁词',
        场景: '通用',
        来源: '作者标注',
        标签: ['AI味'],
        说明: '建议删除',
        正文: '某AI味词',
      })
    })

    afterAll(() => {
      // 清理临时目录
      if (bookRoot) rmSync(bookRoot, { recursive: true, force: true })
    })

    it("loadAiFlavorRule(bookRoot).toPrompt({ bookRoot }) 返回含「某AI味词」", () => {
      const rule = loadAiFlavorRule(bookRoot)
      const text = rule.toPrompt({ bookRoot })
      expect(text).toContain('某AI味词')
    })

    it("loadAiFlavorRule(bookRoot).check('正文含某AI味词', { bookRoot }) 报违规，message 含「建议删除」（说明字段）", () => {
      const rule = loadAiFlavorRule(bookRoot)
      const violations = rule.check('正文含某AI味词', { bookRoot })
      expect(violations.length).toBeGreaterThanOrEqual(1)
      expect(violations[0]!.message).toContain('建议删除')
    })

    it('无 AI味标签词时 toPrompt 返回 null', () => {
      // 空条目库 → 无 AI味标签词 → 空壳规则
      const emptyRoot = mkdtempSync(join(tmpdir(), 'clwriting-rules-empty-'))
      try {
        const rule = loadAiFlavorRule(emptyRoot)
        expect(rule.toPrompt({ bookRoot: emptyRoot })).toBeNull()
      } finally {
        rmSync(emptyRoot, { recursive: true, force: true })
      }
    })
  })
})
