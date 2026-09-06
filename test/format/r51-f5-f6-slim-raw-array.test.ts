/**
 * R51-F-5 / R51-F-6（五十一轮）回归：
 * - F-5：slimIronRules 压 `\n{3,}` 条件化——仅在确有遗留段被删时收敛空行；无遗留段
 *   时排版零改写（调用方 `slimmed !== rulesText` 不再恒真，details 不失真）。
 * - F-6：章 _raw 数组型未知字段按 string[] 原样承载（对齐 leads.ts R64-17）——
 *   此前 String(v) 压成 "a,b" 单串，回写 stringifyValue 按标量引号化后项内逗号错位。
 */
import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { slimIronRules } from '../../src/format/style-migrate.js'
import { readChapter } from '../../src/format/chapters.js'
import { stringifyValue } from '../../src/format/frontmatter.js'

describe('R51-F-5: slimIronRules 压缩空行条件化', () => {
  it('有遗留段被删 → 残留三连空行收敛（既有行为保留）', () => {
    const text = [
      '# 文风铁律',
      '引言。',
      '', // 删段后残留的三连空行形态
      '',
      '',
      '## 反和解段（AI 味防御）',
      '旧内容',
      '',
      '## 可量化约束',
      '阈值。'].join('\n')
    const slim = slimIronRules(text)
    expect(slim).not.toContain('旧内容')
    expect(slim).not.toMatch(/\n{3,}/) // 三连空行被收敛
    expect(slim).toContain('## 可量化约束')
  })

  it('无遗留段 → 原文逐字返回（三连空行排版不改写）', () => {
    const text = ['# 文风铁律', '引言。', '', '', '', '## 作者自加段', '内容。'].join('\n')
    expect(slimIronRules(text)).toBe(text)
  })

  it('无遗留段且文本本就干净 → 原文逐字返回（往返零差异）', () => {
    const text = '# 文风铁律\n\n阈值。'
    expect(slimIronRules(text)).toBe(text)
  })
})

describe('R51-F-6: 章 _raw 数组型未知字段原样承载', () => {
  it('数组型未知字段 → _raw 收 string[]（不落 "a,b" 单串）；标量行为不变', () => {
    const dir = mkdtempSync(join(tmpdir(), 'r51-f6-'))
    try {
      const fp = join(dir, '0001-测试.md')
      writeFileSync(fp, [
        '---',
        '章号: 1',
        '标题: 测试',
        '钩子类型: 危机钩',
        '钩子强弱: 中',
        '情绪定位: 铺垫',
        '自定义数组: [悬疑, 推理]', // 未知字段（数组）
        '自定义标量: 纯文本', // 未知字段（标量）
        '---',
        '',
        '正文。',
      ].join('\n'))
      const r = readChapter(fp)
      expect(r.ok).toBe(true)
      if (!r.ok) return
      const raw = r.chapter._raw ?? {}
      expect(raw['自定义数组']).toEqual(['悬疑', '推理']) // R64-17 同族修法：原样承载
      expect(raw['自定义数组']).not.toBe('悬疑,推理') // 修复前 String(v) 形态
      expect(raw['自定义标量']).toBe('纯文本')
      // 回写面：stringifyValue 对数组逐项序列化（流内逗号分隔，不加内引号）
      expect(stringifyValue(raw['自定义数组'])).toBe('[悬疑, 推理]')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
