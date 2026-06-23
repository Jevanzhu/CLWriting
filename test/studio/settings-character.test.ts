/**
 * P2 角色卡结构化读 + 防穿越校验单测。
 *
 * readCharacterCards:有 front matter 解析结构化字段;无 front matter 降级(兼容旧自由 MD)。
 * validateCharacterFile:PUT 写回防穿越(必须在 定稿/设定/角色/ 下,不含 ..,以 .md 结尾)。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readCharacterCards, validateCharacterFile, buildSettingsContext } from '../../src/studio/server/api/settings.js'

let root = ''

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'clwriting-char-'))
  mkdirSync(join(root, '定稿', '设定', '角色'), { recursive: true })
})

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true })
})

describe('readCharacterCards(P2 结构化读)', () => {
  it('有 front matter:解析 姓名/身份/目标/境界/正文', () => {
    writeFileSync(
      join(root, '定稿', '设定', '角色', '林远.md'),
      '---\n姓名: 林远\n身份: 清虚门弟子\n目标: 查清旧案\n境界: 练气\n---\n性格沉稳,外貌清瘦。',
    )
    const cards = readCharacterCards(join(root, '定稿', '设定', '角色'), root)
    expect(cards).toHaveLength(1)
    expect(cards[0]!.姓名).toBe('林远')
    expect(cards[0]!.身份).toBe('清虚门弟子')
    expect(cards[0]!.目标).toBe('查清旧案')
    expect(cards[0]!.境界).toBe('练气')
    expect(cards[0]!.正文).toBe('性格沉稳,外貌清瘦。')
    expect(cards[0]!.file).toBe('定稿/设定/角色/林远.md')
  })

  it('无 front matter:降级(姓名=文件名,正文=全文)', () => {
    writeFileSync(join(root, '定稿', '设定', '角色', '赵衡.md'), '# 赵衡\n自由描述正文。')
    const cards = readCharacterCards(join(root, '定稿', '设定', '角色'), root)
    expect(cards[0]!.姓名).toBe('赵衡')
    expect(cards[0]!.身份).toBe('')
    expect(cards[0]!.境界).toBe('')
    expect(cards[0]!.正文).toContain('自由描述正文')
  })

  it('缺字段容错(只填姓名,其余空串)', () => {
    writeFileSync(join(root, '定稿', '设定', '角色', '清虚.md'), '---\n姓名: 清虚\n---\n正文')
    const cards = readCharacterCards(join(root, '定稿', '设定', '角色'), root)
    expect(cards[0]!.姓名).toBe('清虚')
    expect(cards[0]!.身份).toBe('')
    expect(cards[0]!.境界).toBe('')
  })

  it('目录不存在 → 空数组', () => {
    expect(readCharacterCards(join(root, '定稿', '设定', '不存在'), root)).toEqual([])
  })

  it('多角色全部解析', () => {
    writeFileSync(join(root, '定稿', '设定', '角色', 'a.md'), '---\n姓名: A\n---\na')
    writeFileSync(join(root, '定稿', '设定', '角色', 'b.md'), '---\n姓名: B\n---\nb')
    expect(readCharacterCards(join(root, '定稿', '设定', '角色'), root)).toHaveLength(2)
  })
})

describe('validateCharacterFile(防穿越)', () => {
  it('合法:定稿/设定/角色/<名>.md', () => {
    expect(validateCharacterFile('定稿/设定/角色/林远.md')).toBe(true)
  })
  it('合法:去前导斜杠', () => {
    expect(validateCharacterFile('/定稿/设定/角色/林远.md')).toBe(true)
  })
  it('合法:Windows 路径分隔符归一化', () => {
    expect(validateCharacterFile('定稿\\设定\\角色\\林远.md')).toBe(true)
  })
  it('非法:不在角色目录', () => {
    expect(validateCharacterFile('定稿/设定/境界体系.md')).toBe(false)
    expect(validateCharacterFile('大纲/总纲.md')).toBe(false)
    expect(validateCharacterFile('定稿/正文/1.md')).toBe(false)
  })
  it('非法:目录穿越 ..', () => {
    expect(validateCharacterFile('定稿/设定/角色/../../../etc/passwd.md')).toBe(false)
    expect(validateCharacterFile('定稿/设定/../../角色/x.md')).toBe(false)
  })
  it('非法:非 .md 后缀', () => {
    expect(validateCharacterFile('定稿/设定/角色/林远.txt')).toBe(false)
  })
})

describe('buildSettingsContext(RAG 注入)', () => {
  it('角色 + 境界 → 两段注入', () => {
    writeFileSync(
      join(root, '定稿', '设定', '角色', '林远.md'),
      '---\n姓名: 林远\n身份: 弟子\n境界: 练气\n---\n正文',
    )
    writeFileSync(
      join(root, '定稿', '设定', '境界体系.md'),
      '---\n体系:\n  - 名称: 修真\n    序列: [炼气, 筑基]\n---\n说明',
    )
    const ctx = buildSettingsContext(root)
    expect(ctx).toContain('角色设定')
    expect(ctx).toContain('林远')
    expect(ctx).toContain('弟子')
    expect(ctx).toContain('境界体系')
    expect(ctx).toContain('炼气')
    expect(ctx).toContain('筑基')
  })

  it('无角色无境界 → 空串(不注入)', () => {
    expect(buildSettingsContext(root)).toBe('')
  })

  it('只有角色 → 只角色段(无境界段)', () => {
    writeFileSync(join(root, '定稿', '设定', '角色', '张三.md'), '---\n姓名: 张三\n---\n正文')
    const ctx = buildSettingsContext(root)
    expect(ctx).toContain('张三')
    expect(ctx).not.toContain('境界体系')
  })
})
