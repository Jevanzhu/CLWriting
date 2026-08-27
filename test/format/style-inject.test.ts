/**
 * 注入预算分配单测（文风系统重整 S5）：便宜段构建 / 样章挑选 / 截断 / 机检禁词合并。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  buildStyleEssentials,
  pickSampleEntries,
  sampleEntryText,
  SAMPLE_INJECT_MAX,
} from '../../src/format/style-inject.js'
import { addEntry } from '../../src/format/style-entry.js'
import { readIronRules } from '../../src/metrics/style.js'
import type { StyleEntry } from '../../src/format/types.js'

const mk = (over: Partial<StyleEntry> & Pick<StyleEntry, '类型' | '正文'>): StyleEntry => ({
  场景: '通用',
  来源: '作者标注',
  ...over,
})

describe('buildStyleEssentials', () => {
  it('三小节组装：禁词一行 + 手法逐条 + 反例带说明；空库 → 空串', () => {
    const entries: StyleEntry[] = [
      mk({ 类型: '禁词', 正文: '深吸一口气' }),
      mk({ 类型: '禁词', 正文: '缓缓' }),
      mk({ 类型: '手法', 正文: '对话不用提示语，用动作断句' }),
      mk({ 类型: '反例', 正文: '他心中涌起难以言喻的感动。', 说明: '抽象情绪总结' }),
    ]
    const text = buildStyleEssentials(entries, ['战斗'])
    expect(text).toContain('禁用：深吸一口气、缓缓')
    expect(text).toContain('写法要点：\n- 对话不用提示语，用动作断句')
    expect(text).toContain('反面例（避免这样写）：\n他心中涌起难以言喻的感动。\n——抽象情绪总结')
    expect(buildStyleEssentials([], ['战斗'])).toBe('')
  })

  it('场景过滤：非本章场景不注；场景命中排本类前，证据强度次之', () => {
    const entries: StyleEntry[] = [
      mk({ 类型: '禁词', 正文: '言情腔', 场景: '言情' }), // 场景不相关 → 不注
      mk({ 类型: '禁词', 正文: '通用词', 场景: '通用', 来源: '改稿行为' }),
      mk({ 类型: '禁词', 正文: '战斗词', 场景: '战斗', 来源: '导入' }),
    ]
    const text = buildStyleEssentials(entries, ['战斗'])
    expect(text).not.toContain('言情腔')
    // 战斗（场景命中）排在通用之前，虽然通用证据更强
    expect(text).toContain('禁用：战斗词、通用词')
  })

  it('反例限 2 条（关键 1–2 条）；样章不进便宜段', () => {
    const entries: StyleEntry[] = [
      mk({ 类型: '反例', 正文: '反1' }),
      mk({ 类型: '反例', 正文: '反2' }),
      mk({ 类型: '反例', 正文: '反3' }),
      mk({ 类型: '样章', 正文: '样章正文' }),
    ]
    const text = buildStyleEssentials(entries, ['战斗'])
    expect(text).toContain('反1')
    expect(text).toContain('反2')
    expect(text).not.toContain('反3')
    expect(text).not.toContain('样章正文')
  })
})

describe('pickSampleEntries / sampleEntryText', () => {
  const entries: StyleEntry[] = [
    mk({ 类型: '样章', 正文: '战1', 场景: '战斗', 来源: '改稿行为' }),
    mk({ 类型: '样章', 正文: '战2', 场景: '战斗', 来源: '收割' }),
    mk({ 类型: '样章', 正文: '话1', 场景: '对话', 来源: '收割' }),
    mk({ 类型: '样章', 正文: '通1', 场景: '通用', 来源: '作者标注' }),
    mk({ 类型: '样章', 正文: '闲1', 场景: '抒情' }), // 非本章场景
  ]

  it('G2 语义：第一轮每场景各 1 保代表，第二轮主场景补满；非本章场景不选', () => {
    const picked3 = pickSampleEntries(entries, ['战斗', '对话'], 3)
    expect(picked3.map((e) => e.正文)).toEqual(['战1', '话1', '通1'])
    const picked4 = pickSampleEntries(entries, ['战斗', '对话'], 4)
    expect(picked4.map((e) => e.正文)).toEqual(['战1', '话1', '通1', '战2'])
    const picked1 = pickSampleEntries(entries, ['战斗', '对话'], 1)
    expect(picked1.map((e) => e.正文)).toEqual(['战1'])
  })

  it('说明作技法指令行；超长正文截断到 500 字', () => {
    expect(sampleEntryText(mk({ 类型: '样章', 正文: '刀光一闪。', 说明: '短句压迫' }))).toBe(
      '技法指令：短句压迫\n刀光一闪。',
    )
    const long = '句'.repeat(SAMPLE_INJECT_MAX + 100)
    const out = sampleEntryText(mk({ 类型: '样章', 正文: long }))
    expect(out.length).toBe(SAMPLE_INJECT_MAX + 2) // 500 字 + 「……」
    expect(out.endsWith('……')).toBe(true)
  })
})

describe('readIronRules 条目库禁词合并（S5 机检收口）', () => {
  let root = ''
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'clwriting-inject-'))
  })
  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true })
  })

  it('硬禁词并入 bannedWords；AI味 标签软禁词不进机检；无铁律文件也能出禁词', () => {
    addEntry(root, mk({ 类型: '禁词', 正文: '势不两立' }))
    addEntry(root, mk({ 类型: '禁词', 正文: '深吸一口气', 标签: ['AI味'], 说明: '删' }))
    const rules = readIronRules(root)
    expect(rules.bannedWords).toEqual(['势不两立'])
  })

  it('铁律 bannedWords 与条目库合并去重', () => {
    mkdirSync(join(root, '文风'), { recursive: true })
    writeFileSync(
      join(root, '文风', '文风铁律.md'),
      '# 文风铁律\n\n## 反和解段\n\n- 「势不两立」\n\n- 「和好如初」\n',
      'utf-8',
    )
    addEntry(root, mk({ 类型: '禁词', 正文: '势不两立' }))
    const rules = readIronRules(root)
    expect(rules.bannedWords?.sort()).toEqual(['势不两立', '和好如初'].sort())
  })

  // R65-16（十三轮）：铁律在盘但读取失败（目录占位：existsSync 真、readFileSync
  // EISDIR，即 existsSync→readFileSync 间隙瞬删的 TOCTOU 形态）→ 按空规则降级
  // 不炸机检/文风重扫，条目库禁词合并照常
  it('R65-16: 铁律在盘但读取失败 → 空规则降级不炸，条目库禁词照常并入', () => {
    mkdirSync(join(root, '文风'), { recursive: true })
    mkdirSync(join(root, '文风', '文风铁律.md'), { recursive: true }) // 目录占位触发 EISDIR
    addEntry(root, mk({ 类型: '禁词', 正文: '势不两立' }))
    const rules = readIronRules(root)
    expect(rules.maxSentenceLen).toBeUndefined() // 铁律未读成 → 可量化阈值按空
    expect(rules.bannedWords).toEqual(['势不两立']) // 条目库禁词合并不受影响
  })
})
