/**
 * R30-15（三十轮）回归：禁词注入段与机检取词口径同源。
 *
 * 修法：style-inject.buildStyleEssentials 的禁用段改用 style-entry.bannedEntryWords
 * （与机检 readBannedEntryWords 同一单源）逐行拆词——原实现把条目正文整段
 * （可含多行说明文本）join 注入，说明性条目整段原文进 prompt 白烧预算。
 * 解析不出词的条目不注入（机检侧已产 unparsed 黄项）。
 */
import { test, expect } from 'vitest'
import { buildStyleEssentials } from '../../src/format/style-inject.js'
import type { StyleEntry } from '../../src/format/types.js'

const mk = (over: Partial<StyleEntry> & Pick<StyleEntry, '类型' | '正文'>): StyleEntry => ({
  场景: '通用',
  来源: '作者标注',
  ...over,
})

test('R30-15: 说明性禁词条目不再整段进注入段（只注解析出的词）', () => {
  const entries: StyleEntry[] = [
    mk({ 类型: '禁词', 正文: '深吸一口气' }),
    // 说明性条目（机检侧解析不出词 → unparsed 黄项）：注入侧不再把整段原文带上。
    // 两行均含占位标记（示例/待补），parseBannedWordsLine 清洗后零词——与机检同判。
    mk({ 类型: '禁词', 正文: '示例条目：待作者补充真正的禁词。\n这里是给作者看的说明文字（示例非禁词）。' }),
  ]
  const text = buildStyleEssentials(entries, ['战斗'])
  expect(text).toContain('禁用：深吸一口气')
  expect(text).not.toContain('示例条目')
  expect(text).not.toContain('说明文字')
})

test('R30-15: 全部禁词条目都解析不出词 → 禁用段整体跳过（不出「禁用：」空壳）', () => {
  const entries: StyleEntry[] = [
    mk({ 类型: '禁词', 正文: '示例条目：待作者补充。' }),
  ]
  const text = buildStyleEssentials(entries, ['战斗'])
  expect(text).not.toContain('禁用：')
  expect(text).not.toContain('示例条目')
})

test('R30-15: 同源口径——单行顿号多词/引号词照常解析注入（机检同款拆词）', () => {
  const entries: StyleEntry[] = [
    mk({ 类型: '禁词', 正文: '「深吸一口气」「缓缓」' }),
    mk({ 类型: '禁词', 正文: '言情腔、口头禅' }),
  ]
  const text = buildStyleEssentials(entries, ['战斗'])
  expect(text).toContain('禁用：深吸一口气、缓缓、言情腔、口头禅')
})
