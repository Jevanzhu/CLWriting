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
      // 建 设定/角色/角色-001.md，front matter 含 姓名:林远
      const roleDir = join(bookRoot, '设定', '角色')
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
      expect(hit).toEqual(expect.objectContaining({ ruleId: 'setting-consistency', level: 'yellow' }))
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

describe('R48-3（四十八轮）：check 域口径对齐（check/count.ts checkNewNames 同源守卫族）', () => {
  let bookRoot: string

  beforeAll(() => {
    bookRoot = mkdtempSync(join(tmpdir(), 'clwriting-setting-r48-3-'))
    mkdirSync(join(bookRoot, '设定'), { recursive: true })
    // 名册面：标题/列表/括注/顿号多形态（parseRosterNamesLocal 解析口径）
    writeFileSync(
      join(bookRoot, '设定', '名册.md'),
      [
        '# 名册',
        '',
        '## 主要人物',
        '- 林晚晴（女主）',
        '- 沈青梧、苏牧野',
        '',
        '已登记：赵无咎',
        '',
      ].join('\n'),
      'utf-8',
    )
  })

  afterAll(() => {
    if (bookRoot) rmSync(bookRoot, { recursive: true, force: true })
  })

  const reported = (body: string, keyword: string): boolean =>
    settingConsistencyRule.check(body, { bookRoot }).some((v) => v.message.includes(keyword))

  it('对白行「快走。」林晚说。不再报伪专名（整行归属豁免，X-P2-9 口径）', () => {
    expect(reported('「快走。」林晚说。', '快走')).toBe(false)
  })

  it('动作+对白混排行「他低声道：……」不再报伪专名（句读守卫，R76-3 口径）', () => {
    expect(reported('他低声道：“别动。”然后按住她的肩。', '别动')).toBe(false)
  })

  it('引导词+引语（林晚喊道「站住」…）不再报伪专名（R29-B12 口径）', () => {
    expect(reported('林晚喊道“站住”，追了出去。', '站住')).toBe(false)
  })

  it('叙述行未登记专名「玄铁剑」仍照报（对齐不致失明）', () => {
    expect(reported('他握紧了「玄铁剑」。', '玄铁剑')).toBe(true)
  })

  it('名册精确比对：候选「沈青」不再被长名「沈青梧」includes 吞掉 → 照报（R30-2 口径）', () => {
    expect(reported('「沈青」出现在门口。', '沈青')).toBe(true)
  })

  it('名册登记名「林晚晴」精确放行', () => {
    expect(reported('「林晚晴」推门而入。', '林晚晴')).toBe(false)
  })

  it('弯引号“段清衡”此前整段不可见（旧字符集漏弯引号），现照报（LENIENT 对齐）', () => {
    expect(reported('帐外传来“段清衡”的自报名号。', '段清衡')).toBe(true)
  })
})
