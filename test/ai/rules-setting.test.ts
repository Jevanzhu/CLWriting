/**
 * A3 settingConsistencyRule（设定一致规则）单测。
 *
 * 覆盖：
 * - 无设定目录 → toPrompt null / check 空
 * - 有角色卡 → toPrompt 含「设定一致」约束
 * - 引号内未登记专名 → check 报黄
 * - 已登记名 → check 不报
 * - 干净正文（无引号专名）→ check 空
 *
 * 测试自包含，不依赖外部书库；临时目录用 mkdtempSync 创建、rmSync 清理。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { settingConsistencyRule } from '../../src/ai/rules/setting-rule.js'

describe('A3 settingConsistencyRule（设定一致规则）', () => {
  describe('无设定目录（短篇集/新书）', () => {
    let bookRoot: string

    beforeAll(() => {
      bookRoot = mkdtempSync(join(tmpdir(), 'clwriting-setting-empty-'))
    })

    afterAll(() => {
      if (bookRoot) rmSync(bookRoot, { recursive: true, force: true })
    })

    it('toPrompt 返回 null', () => {
      expect(settingConsistencyRule.toPrompt({ bookRoot })).toBeNull()
    })

    it('check 返回空数组', () => {
      const violations = settingConsistencyRule.check('正文「张三」走了过来', { bookRoot })
      expect(violations).toEqual([])
    })
  })

  describe('有设定目录（角色卡含 姓名:林远）', () => {
    let bookRoot: string

    beforeAll(() => {
      bookRoot = mkdtempSync(join(tmpdir(), 'clwriting-setting-'))
      // 建 定稿/设定/角色/角色-001.md，front matter 含 姓名:林远
      const roleDir = join(bookRoot, '定稿', '设定', '角色')
      mkdirSync(roleDir, { recursive: true })
      writeFileSync(
        join(roleDir, '角色-001.md'),
        '---\n姓名: 林远\n---\n角色正文',
        'utf-8',
      )
    })

    afterAll(() => {
      if (bookRoot) rmSync(bookRoot, { recursive: true, force: true })
    })

    it('toPrompt 返回含「设定一致」的约束文本', () => {
      const text = settingConsistencyRule.toPrompt({ bookRoot })
      expect(text).not.toBeNull()
      expect(text).toContain('设定一致')
    })

    it("正文含引号内未登记专名「张三」→ check 报黄，message 含「张三」", () => {
      const violations = settingConsistencyRule.check('林远看着「张三」走过来', { bookRoot })
      expect(violations.length).toBeGreaterThanOrEqual(1)
      const hit = violations.find((v) => v.message.includes('张三'))
      expect(hit).toBeDefined()
      expect(hit!.ruleId).toBe('setting-consistency')
      expect(hit!.level).toBe('yellow')
    })

    it("正文含已登记名「林远」→ check 不报该名", () => {
      const violations = settingConsistencyRule.check('「林远」走了过来', { bookRoot })
      const hit = violations.find((v) => v.message.includes('林远'))
      expect(hit).toBeUndefined()
    })

    it('干净正文（无引号专名）→ check 返回空数组', () => {
      const violations = settingConsistencyRule.check('一段普通的描写，没有任何引号内容', { bookRoot })
      expect(violations).toEqual([])
    })
  })
})
