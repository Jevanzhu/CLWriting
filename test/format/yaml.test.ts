import { test, expect } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  readBookConfig,
  writeBookConfig,
  stringifyBookConfig,
  patchTopSection,
  DEFAULT_CONFIG,
} from '../../src/format/yaml.js'

test('readBookConfig: 完整解析（#9 第 2 节）', () => {
  const dir = mkdtempSync(join(tmpdir(), '北境往事-'))
  const fp = join(dir, 'book.yaml')
  writeFileSync(fp, [
    'spec_version: 1',
    '',
    'book:',
    '  title: 北境往事',
    '  genre: 玄幻',
    '  volume_size: 40',
    '',
    'leads:',
    '  enabled: [布局线, 设定线, 成长线]',
    '  thresholds:',
    '    成长线: 50',
    '',
    'budget:',
    '  calls_per_chapter: 8',
    '  input_per_chapter: 80000',
    '  summary_chapter_max: 200',
    '  summary_volume_max: 500',
    '',
    'style:',
    '  injection: light',
    '',
    'auto:',
    '  confirm_outline: false',
    '  batch_size: 8',
    '',
    'growth:',
    '  realm_span_max: 2',
  ].join('\n'), 'utf-8')

  const r = readBookConfig(fp)
  expect(r.ok).toBe(true)
  if (r.ok) {
    expect(r.config.book.title).toBe('北境往事')
    expect(r.config.book.genre).toBe('玄幻')
    expect(r.config.book.volume_size).toBe(40)
    expect(r.config.leads.enabled).toEqual(['布局线', '设定线', '成长线'])
    expect(r.config.leads.thresholds?.['成长线']).toBe(50)
    expect(r.config.budget.calls_per_chapter).toBe(8)
    expect(r.config.auto.confirm_outline).toBe(false)
    expect(r.config.growth.realm_span_max).toBe(2)
  }
  rmSync(dir, { recursive: true, force: true })
})

test('writeBookConfig + readBookConfig: 可选 volume_size 往返', () => {
  const dir = mkdtempSync(join(tmpdir(), '北境往事-'))
  const fp = join(dir, 'book.yaml')
  writeBookConfig(fp, {
    ...DEFAULT_CONFIG,
    book: { title: '雪落长安', genre: '历史', volume_size: 30 },
  })
  const r = readBookConfig(fp)
  expect(r.ok).toBe(true)
  if (r.ok) {
    expect(r.config.book.volume_size).toBe(30)
  }
  rmSync(dir, { recursive: true, force: true })
})

test('readBookConfig: 文件不存在返回默认', () => {
  const r = readBookConfig(join(tmpdir(), '不存在-' + Date.now() + '.yaml'))
  expect(r.ok).toBe(false)
  expect(r.config).toEqual(DEFAULT_CONFIG)
})

test('X-P2-17: 错误分支返回默认配置深拷贝——调用方 mutate 不串污染单例', () => {
  const r1 = readBookConfig(join(tmpdir(), '不存在-' + Date.now() + '.yaml'))
  expect(r1.ok).toBe(false)
  if (!r1.ok) {
    r1.config.book.title = '污染'
    r1.config.budget.calls_per_chapter = 999
  }
  // 再读一次：模块级 DEFAULT_CONFIG 未被上一份返回值污染
  const r2 = readBookConfig(join(tmpdir(), '不存在-' + Date.now() + '.yaml'))
  expect(r2.config.book.title).toBe('')
  expect(r2.config.budget.calls_per_chapter).toBe(DEFAULT_CONFIG.budget.calls_per_chapter)
  expect(DEFAULT_CONFIG.book.title).toBe('')
})

test('writeBookConfig + readBookConfig 往返', () => {
  const dir = mkdtempSync(join(tmpdir(), '北境往事-'))
  const fp = join(dir, 'book.yaml')
  const cfg = {
    ...DEFAULT_CONFIG,
    book: { title: '雪落长安', genre: '历史' },
    leads: { enabled: ['布局线'], thresholds: { 布局线: 20 } },
  }
  writeBookConfig(fp, cfg)
  const r = readBookConfig(fp)
  expect(r.ok).toBe(true)
  if (r.ok) {
    expect(r.config.book.title).toBe('雪落长安')
    expect(r.config.leads.enabled).toEqual(['布局线'])
    expect(r.config.leads.thresholds?.['布局线']).toBe(20)
  }
  rmSync(dir, { recursive: true, force: true })
})

test('RB-KN-P2-10: auto.relation_auto_mine / relation_mine_threshold 解析 + 序列化往返', () => {
  const dir = mkdtempSync(join(tmpdir(), '北境往事-'))
  const fp = join(dir, 'book.yaml')
  writeBookConfig(fp, {
    ...DEFAULT_CONFIG,
    auto: { ...DEFAULT_CONFIG.auto, relation_auto_mine: false, relation_mine_threshold: 7 },
  })
  // 序列化包含两键（缺省不输出的红线只约束未配置的书）
  const text = readFileSync(fp, 'utf-8')
  expect(text).toContain('relation_auto_mine: false')
  expect(text).toContain('relation_mine_threshold: 7')
  // 读回不丢（修复前：解析不支持 → 永远回落默认）
  const r = readBookConfig(fp)
  expect(r.ok).toBe(true)
  if (r.ok) {
    expect(r.config.auto.relation_auto_mine).toBe(false)
    expect(r.config.auto.relation_mine_threshold).toBe(7)
  }
  // 缺省书不落两键（现有仓库零改动红线）
  expect(stringifyBookConfig(DEFAULT_CONFIG)).not.toContain('relation_auto_mine')
  expect(stringifyBookConfig(DEFAULT_CONFIG)).not.toContain('relation_mine_threshold')
  rmSync(dir, { recursive: true, force: true })
})

test('readBookConfig: 数字字段坏值回落默认，不注入 NaN', () => {
  const dir = mkdtempSync(join(tmpdir(), '北境往事-'))
  const fp = join(dir, 'book.yaml')
  writeFileSync(fp, [
    'spec_version: abc',
    'leads:',
    '  thresholds:',
    '    成长线: nope',
    'budget:',
    '  calls_per_chapter: abc',
    '  input_per_chapter: 90000',
    'auto:',
    '  batch_size: nope',
    'growth:',
    '  realm_span_max: nope',
  ].join('\n'), 'utf-8')

  const r = readBookConfig(fp)
  expect(r.ok).toBe(true)
  if (r.ok) {
    expect(r.config.spec_version).toBe(1)
    expect(r.config.budget.calls_per_chapter).toBe(DEFAULT_CONFIG.budget.calls_per_chapter)
    expect(r.config.budget.input_per_chapter).toBe(90000)
    expect(r.config.auto.batch_size).toBe(DEFAULT_CONFIG.auto.batch_size)
    expect(r.config.growth.realm_span_max).toBe(DEFAULT_CONFIG.growth.realm_span_max)
    expect(r.config.leads.thresholds?.['成长线']).toBeUndefined()
  }
  rmSync(dir, { recursive: true, force: true })
})

test('stringifyBookConfig: leads.enabled 为空数组时合法', () => {
  const text = stringifyBookConfig(DEFAULT_CONFIG)
  expect(text).toContain('enabled: []')
  expect(text).toContain('spec_version: 1')
})

// ── workflow 字段已删除（W0 §2 废弃）──
// 存量 book.yaml 里的 workflow 行是未知字段：解析不赋值、输出不写，
// 下次存配置 stringifyBookConfig 重建时自然丢弃（无行为字段，无兼容负担）。

test('workflow: 存量 book.yaml 的 workflow 行不再解析/输出（删除语义）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wf-'))
  const fp = join(dir, 'book.yaml')
  writeFileSync(fp, ['spec_version: 1', '', 'workflow: 自由', ''].join('\n'), 'utf-8')
  const r = readBookConfig(fp)
  expect(r.ok).toBe(true)
  if (r.ok) {
    // 字段类型已删：解析不再产出 workflow
    expect('workflow' in r.config).toBe(false)
    // 重建输出不写 workflow 行
    expect(stringifyBookConfig(r.config)).not.toContain('workflow')
  }
  rmSync(dir, { recursive: true, force: true })
})

test('snapshots 段：缺省不输出（零改动红线）；有值往返一致', () => {
  expect(stringifyBookConfig(DEFAULT_CONFIG)).not.toContain('snapshots')

  const text = stringifyBookConfig({
    ...DEFAULT_CONFIG,
    snapshots: { max_days: 30, max_count: 50 },
  })
  expect(text).toContain('snapshots:')
  expect(text).toContain('  max_days: 30')
  expect(text).toContain('  max_count: 50')

  const dir = mkdtempSync(join(tmpdir(), 'yaml-snap-'))
  writeFileSync(join(dir, 'book.yaml'), text, 'utf-8')
  const r = readBookConfig(join(dir, 'book.yaml'))
  expect(r.ok).toBe(true)
  if (r.ok) {
    expect(r.config.snapshots?.max_days).toBe(30)
    expect(r.config.snapshots?.max_count).toBe(50)
  }
  rmSync(dir, { recursive: true, force: true })
})

test('snapshots 段：非正数值忽略（回落代码默认）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'yaml-snap-bad-'))
  writeFileSync(
    join(dir, 'book.yaml'),
    'spec_version: 1\nbook:\n  title: 书\n  genre: 玄幻\nsnapshots:\n  max_days: 0\n  max_count: -5\n',
    'utf-8',
  )
  const r = readBookConfig(join(dir, 'book.yaml'))
  expect(r.ok).toBe(true)
  if (r.ok) expect(r.config.snapshots).toBeUndefined()
  rmSync(dir, { recursive: true, force: true })
})

// ── V-P2-4：patchTopSection 文本级段补丁（读改写保注释/未知段）────────

test('patchTopSection: 替换中间段，前后原文逐字保留', () => {
    const raw = 'a: 1\n# 注释\nrag:\n  enabled: false\n\nb: 2\n'
    const out = patchTopSection(raw, 'rag', '  enabled: true\n  model: m')
    expect(out).toBe('a: 1\n# 注释\nrag:\n  enabled: true\n  model: m\n\nb: 2\n')
  })

test('patchTopSection: 段不存在 → 追加（空行分隔）', () => {
    const raw = 'a: 1\n'
    const out = patchTopSection(raw, 'rag', '  enabled: true')
    expect(out).toBe('a: 1\n\nrag:\n  enabled: true\n')
  })

test('patchTopSection: 空文件 → 纯新段', () => {
    expect(patchTopSection('', 'rag', '  enabled: true')).toBe('rag:\n  enabled: true\n')
  })

test('patchTopSection: 段内注释被替换（段区间归段所有），段外注释保留', () => {
    const raw = '# 外注释\nrag:\n# 段内注释\n  enabled: false\nhost: cc\n'
    const out = patchTopSection(raw, 'rag', '  enabled: true')
    expect(out).toBe('# 外注释\nrag:\n  enabled: true\nhost: cc\n')
  })

test('patchTopSection: 无尾换行文件 → 补齐结构', () => {
    const out = patchTopSection('a: 1', 'rag', '  enabled: true')
    expect(out).toBe('a: 1\n\nrag:\n  enabled: true\n')
  })
