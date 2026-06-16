import { test, expect } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  readBookConfig,
  writeBookConfig,
  stringifyBookConfig,
  DEFAULT_CONFIG,
} from '../../src/format/yaml.js'

test('readBookConfig: 完整解析（⑨ 第 2 节）', () => {
  const dir = mkdtempSync(join(tmpdir(), '北境往事-'))
  const fp = join(dir, 'book.yaml')
  writeFileSync(fp, [
    'spec_version: 1',
    '',
    'book:',
    '  title: 北境往事',
    '  genre: 玄幻',
    '',
    'leads:',
    '  enabled: [局线, 设定线, 成长线]',
    '  thresholds:',
    '    成长线: 50',
    '',
    'budget:',
    '  calls_per_chapter: 6',
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
    expect(r.config.leads.enabled).toEqual(['局线', '设定线', '成长线'])
    expect(r.config.leads.thresholds?.['成长线']).toBe(50)
    expect(r.config.budget.calls_per_chapter).toBe(6)
    expect(r.config.auto.confirm_outline).toBe(false)
    expect(r.config.growth.realm_span_max).toBe(2)
  }
  rmSync(dir, { recursive: true, force: true })
})

test('readBookConfig: 文件不存在返回默认', () => {
  const r = readBookConfig(join(tmpdir(), '不存在-' + Date.now() + '.yaml'))
  expect(r.ok).toBe(false)
  expect(r.config).toEqual(DEFAULT_CONFIG)
})

test('writeBookConfig + readBookConfig 往返', () => {
  const dir = mkdtempSync(join(tmpdir(), '北境往事-'))
  const fp = join(dir, 'book.yaml')
  const cfg = {
    ...DEFAULT_CONFIG,
    book: { title: '雪落长安', genre: '历史' },
    leads: { enabled: ['局线'], thresholds: { 局线: 20 } },
  }
  writeBookConfig(fp, cfg)
  const r = readBookConfig(fp)
  expect(r.ok).toBe(true)
  if (r.ok) {
    expect(r.config.book.title).toBe('雪落长安')
    expect(r.config.leads.enabled).toEqual(['局线'])
    expect(r.config.leads.thresholds?.['局线']).toBe(20)
  }
  rmSync(dir, { recursive: true, force: true })
})

test('stringifyBookConfig: leads.enabled 为空数组时合法', () => {
  const text = stringifyBookConfig(DEFAULT_CONFIG)
  expect(text).toContain('enabled: []')
  expect(text).toContain('spec_version: 1')
})
