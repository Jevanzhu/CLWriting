/**
 * r0914b（全库重评-0914 修复批 B）P3-12：iron-rules 段采集标题前置闸零空白容忍。
 *
 * 此前 extractSection 标题闸 `/^(#{1,6})\s+/` 强制空格，段锚定正则（ANTI_RECON_HEADING_RE
 * /BANNED_LIST_HEADING_RE）的 `\s*` 零空白容忍被闸拦截永不生效——紧凑标题 `##硬禁词`
 * 段静默失明（段内条目被折入证据不进红闸）。
 */
import { test, expect } from 'vitest'
import { parseIronRules } from '../../src/format/iron-rules.js'

test('r0914b P3-12: 紧凑标题 `##硬禁词` 段条目可采集（锚定正则零空白容忍生效）', () => {
  const rules = parseIronRules(
    ['##硬禁词', '- 禁词：轰动体 / 倒吸凉气', '- 「时间静止」', '', '## 可量化约束', '- 单句上限字数: 60'].join('\n'),
  )
  // 紧凑段标题下的条目全部采集；后继同级标题（带空格形态）照旧段终，不污染
  expect(rules.bannedWords).toEqual(['轰动体', '倒吸凉气', '时间静止'])
  expect(rules.maxSentenceLen).toBe(60)
})

test('r0914b P3-12: 紧凑 `##反和解段（AI 味防御）` 与裸形 `##反和解段` 各自可采集', () => {
  // 同族双段并存在单文本内不在本次修复面（单次扫描同族第二段不采集系 extractSection
  // 既有形态，注释已登记）——两形态分文本各自验证零空白容忍生效
  const full = parseIronRules(['##反和解段（AI 味防御）', '- 禁止：蝼蚁、天命所归'].join('\n'))
  expect(full.bannedWords).toEqual(['蝼蚁', '天命所归'])
  const bare = parseIronRules(['##反和解段', '- 「会让你们后悔」'].join('\n'))
  expect(bare.bannedWords).toEqual(['会让你们后悔'])
})

test('r0914b P3-12: 段内紧凑同级标题按段终处理（不再折入证据）', () => {
  const rules = parseIronRules(['## 硬禁词清单', '- 禁词：轰动体', '', '##其他段', '- 「倒吸凉气」'].join('\n'))
  // 同级紧凑标题（level 2 <= sectionLevel 2）终断前段，其后条目不入采集
  expect(rules.bannedWords).toEqual(['轰动体'])
})
