/**
 * A3 plotConsistencyRule（情节一致规则）单测。
 *
 * 覆盖六个场景：
 * 1. ctx.chapter 为 undefined → 空数组
 * 2. 无章纲目录 → 空数组
 * 3. toPrompt 返回含「章纲声明」的约束
 * 4. 钩子类型偏差 → 报黄，message 含章纲值与草稿值
 * 5. 章纲与草稿 fm 一致 → 空数组
 * 6. 草稿 fm 缺某字段 → 该字段不报
 *
 * 自包含：mkdtempSync 造临时书库，afterAll rmSync 清理。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { plotConsistencyRule } from '../../src/ai/rules/plot-rule.js'

describe('A3 plotConsistencyRule（情节一致规则）', () => {
  let bookRoot: string

  beforeAll(() => {
    // 造临时书库 + 章纲目录
    bookRoot = mkdtempSync(join(tmpdir(), 'clwriting-plot-'))
    mkdirSync(join(bookRoot, '大纲', '章纲'), { recursive: true })
    // 章纲 fixture：章号 1，钩子类型=悬念钩，情绪定位=铺垫，场景=对话
    writeFileSync(
      join(bookRoot, '大纲', '章纲', '0001-测试.md'),
      '---\n章号: 1\n标题: 测试\n钩子类型: 悬念钩\n情绪定位: 铺垫\n场景: 对话\n---\n章纲正文\n',
      'utf-8',
    )
  })

  afterAll(() => {
    if (bookRoot) rmSync(bookRoot, { recursive: true, force: true })
  })

  it('ctx.chapter 为 undefined → check 返回空数组', () => {
    const violations = plotConsistencyRule.check('---\n章号: 1\n---\n正文\n', { bookRoot })
    expect(violations).toHaveLength(0)
  })

  it('无章纲目录 → check 返回空数组', () => {
    // 空临时目录（无 大纲/章纲 结构）
    const emptyRoot = mkdtempSync(join(tmpdir(), 'clwriting-plot-empty-'))
    try {
      const violations = plotConsistencyRule.check('---\n章号: 1\n---\n正文\n', {
        bookRoot: emptyRoot,
        chapter: 1,
      })
      expect(violations).toHaveLength(0)
    } finally {
      rmSync(emptyRoot, { recursive: true, force: true })
    }
  })

  it('toPrompt 返回含「章纲声明」的约束（不依赖章纲存在）', () => {
    const text = plotConsistencyRule.toPrompt({ bookRoot: '' })
    expect(text).toContain('章纲声明')
  })

  it('章纲钩子类型=悬念钩，草稿 fm 钩子类型=危机钩 → 报黄，message 含「悬念钩」和「危机钩」', () => {
    const body =
      '---\n章号: 1\n标题: 测试\n钩子类型: 危机钩\n情绪定位: 铺垫\n场景: 对话\n---\n草稿正文\n'
    const violations = plotConsistencyRule.check(body, { bookRoot, chapter: 1 })
    expect(violations).toHaveLength(1)
    expect(violations[0]!.ruleId).toBe('plot-consistency')
    expect(violations[0]!.level).toBe('yellow')
    expect(violations[0]!.message).toContain('悬念钩')
    expect(violations[0]!.message).toContain('危机钩')
  })

  it('章纲和草稿 fm 一致 → check 返回空数组', () => {
    const body =
      '---\n章号: 1\n标题: 测试\n钩子类型: 悬念钩\n情绪定位: 铺垫\n场景: 对话\n---\n草稿正文\n'
    const violations = plotConsistencyRule.check(body, { bookRoot, chapter: 1 })
    expect(violations).toHaveLength(0)
  })

  it('草稿 fm 缺失某字段 → 该字段不报（跳过）', () => {
    // 草稿 fm 缺「场景」字段；钩子类型/情绪定位与章纲一致 → 场景跳过，无违规
    const body = '---\n章号: 1\n标题: 测试\n钩子类型: 悬念钩\n情绪定位: 铺垫\n---\n草稿正文\n'
    const violations = plotConsistencyRule.check(body, { bookRoot, chapter: 1 })
    expect(violations).toHaveLength(0)
  })
})
