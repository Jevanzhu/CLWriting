/**
 * R57-D-1（五十七轮）回归：book.yaml budget 段 / leads.thresholds 段内重复子键
 * fail-loud——此前两段直接遍历 children 取值，段内同名子键后值静默覆盖前值（作者
 * 复制粘贴出两行同键时前值无声失效）。对齐 findChild（R73-21）与顶层段重复
 * （R72-8）的「宁可红不可错」口径：重复即报错（parseBookConfig 捕获转错误信封），
 * 不再静默覆盖。
 */
import { test, expect } from 'vitest'
import { parseBookConfig } from '../../src/format/yaml.js'

test('R57-D-1: budget 段重复子键 → fail-loud（后值不再静默覆盖前值）', () => {
  const out = parseBookConfig([
    'spec_version: 1',
    'budget:',
    '  calls_per_chapter: 8',
    '  calls_per_chapter: 9',
    '',
  ].join('\n'))
  expect(out.ok).toBe(false)
  if (!out.ok) {
    // 报错文案镜像 findChild（R73-21）既有形态，不自创第三种口径
    expect(out.error.message).toContain('顶层段「budget」内子键「calls_per_chapter」重复')
    expect(out.error.message).toContain('请合并或删除重复键')
  }
})

test('R57-D-1: leads.thresholds 段重复子键 → fail-loud（后值不再静默覆盖前值）', () => {
  const out = parseBookConfig([
    'leads:',
    '  enabled: [布局线]',
    '  thresholds:',
    '    布局线: 20',
    '    布局线: 50',
    '',
  ].join('\n'))
  expect(out.ok).toBe(false)
  if (!out.ok) {
    expect(out.error.message).toContain('顶层段「thresholds」内子键「布局线」重复')
    expect(out.error.message).toContain('请合并或删除重复键')
  }
})

test('R57-D-1: 无重复子键时行为不变（budget/thresholds 正常解析、后值覆盖面不扩大）', () => {
  const out = parseBookConfig([
    'budget:',
    '  calls_per_chapter: 8',
    '  input_per_chapter: 80000',
    '',
    'leads:',
    '  enabled: [布局线, 成长线]',
    '  thresholds:',
    '    布局线: 20',
    '    成长线: 50',
    '',
  ].join('\n'))
  expect(out.ok).toBe(true)
  if (out.ok) {
    expect(out.config.budget.calls_per_chapter).toBe(8)
    expect(out.config.budget.input_per_chapter).toBe(80000)
    expect(out.config.leads.thresholds?.['布局线']).toBe(20)
    expect(out.config.leads.thresholds?.['成长线']).toBe(50)
  }
})
