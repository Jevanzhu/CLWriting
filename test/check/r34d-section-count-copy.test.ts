/**
 * R34D-12（三十四轮）回归：节数守恒文案按实际 expected 插值，不再硬编码「五段」。
 *
 * 修复背景：section_count 可配置（runner 传 short.section_count），但文案硬编码
 * 「五段结构」并枚举 5 个节名——配置 ≠5 的 strict 短篇把黄提红后 formatRedForRewrite
 * 喂给自愈重写，重写目标被误导成五段。修后：期望值统一插值 expected；五段节名枚举
 * 仅缺省 5 段时保留（≠5 去枚举按期望节数描述）。
 */
import { test, expect } from 'vitest'
import { checkSectionCount } from '../../src/check/count.js'

test('R34D-12: section_count=3 节数不符文案含期望值 3、不含「五段」', () => {
  const body = '## 一\nx\n## 二\nx\n## 三\nx\n## 四\nx' // 4 节 ≠ 3
  const r = checkSectionCount(body, 3)
  expect(r.items).toHaveLength(1)
  const msg = r.items[0]!.message
  expect(msg).toContain('正文 4 节')
  expect(msg).toContain('3')
  expect(msg).not.toContain('五段')
})

test('R34D-12: section_count=3 无标题文案按 3 插值、不枚举五段节名', () => {
  const r = checkSectionCount('段一\n\n段二', 3)
  expect(r.items[0]!.checkId).toBe('section-count-heading-missing')
  const msg = r.items[0]!.message
  expect(msg).toContain('3')
  expect(msg).not.toContain('五段')
  expect(msg).not.toContain('## 开头钩子')
  expect(msg).toContain('不按自然段计节') // 既有断言口径保持
})

test('R34D-12: section_count=3 单标题分支同样插值', () => {
  const r = checkSectionCount('## 开头\n只有一段标题的正文', 3)
  expect(r.items[0]!.checkId).toBe('section-count-heading-missing')
  const msg = r.items[0]!.message
  expect(msg).toContain('仅检测到 1 个') // RB-KN-P2-7 既有口径保持
  expect(msg).toContain('3')
  expect(msg).not.toContain('五段')
})

test('R34D-12: 缺省 5 段文案保持既有节名指引（零回归）', () => {
  const r = checkSectionCount('段一\n\n段二', 5)
  const msg = r.items[0]!.message
  expect(msg).toContain('五段结构')
  expect(msg).toContain('## 开头钩子 / ## 铺垫 / ## 升级 / ## 反转 / ## 余韵')
  expect(msg).toContain('不按自然段计节')
})

test('R34D-12: 节数不符文案统一插值（缺省 5 时仍报「期望 5 节」）', () => {
  const r = checkSectionCount('## 一\nx\n## 二\nx', 5)
  expect(r.items[0]!.message).toBe('正文 2 节，期望 5 节（节数守恒）')
})
