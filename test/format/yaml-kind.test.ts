/**
 * book.yaml kind 字段读写测试 —— M8 #25。
 *
 * 验收红线：
 * - 缺省（无 kind）→ config.kind 为 undefined（语义 = long）
 * - 显式 kind: short → config.kind = 'short'
 * - stringify 只在 short 时输出 kind 行（长篇零改动，现有仓库不变）
 */

import { test, expect } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readBookConfig, stringifyBookConfig, DEFAULT_CONFIG } from '../../src/format/yaml.js'

test('kind: 无 kind 字段 → config.kind 为 undefined（缺省 = long）', () => {
  const root = mkdtempSync(join(tmpdir(), 'yaml-kind-'))
  try {
    writeFileSync(join(root, 'book.yaml'), 'spec_version: 1\n\nbook:\n  title: 测\n  genre: 玄幻\n', 'utf-8')
    const r = readBookConfig(join(root, 'book.yaml'))
    expect(r.ok).toBe(true)
    expect(r.config.kind).toBeUndefined() // 缺省 = long 语义
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('kind: 显式 short → config.kind = short', () => {
  const root = mkdtempSync(join(tmpdir(), 'yaml-kind-'))
  try {
    writeFileSync(join(root, 'book.yaml'), 'spec_version: 1\nkind: short\n\nbook:\n  title: 集\n  genre: 悬疑\n', 'utf-8')
    const r = readBookConfig(join(root, 'book.yaml'))
    expect(r.ok).toBe(true)
    expect(r.config.kind).toBe('short')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('kind: 坏值（kind: middle）→ 忽略，config.kind 为 undefined', () => {
  const root = mkdtempSync(join(tmpdir(), 'yaml-kind-'))
  try {
    writeFileSync(join(root, 'book.yaml'), 'spec_version: 1\nkind: middle\n\nbook:\n  title: 集\n  genre: 悬疑\n', 'utf-8')
    const r = readBookConfig(join(root, 'book.yaml'))
    expect(r.ok).toBe(true)
    expect(r.config.kind).toBeUndefined() // 非法值忽略
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('stringify: kind === short 时输出 kind: short 行；长篇/缺省不输出', () => {
  // long（缺省）：不输出 kind 行
  const longYaml = stringifyBookConfig({ ...DEFAULT_CONFIG, book: { title: '长', genre: '玄幻' } })
  expect(longYaml).not.toContain('kind:')

  // short：输出 kind: short
  const shortYaml = stringifyBookConfig({ ...DEFAULT_CONFIG, kind: 'short', book: { title: '集', genre: '悬疑' } })
  expect(shortYaml).toContain('kind: short')
  // 短篇精简：无 leads / growth 段
  expect(shortYaml).not.toContain('leads:')
  expect(shortYaml).not.toContain('growth:')
  expect(shortYaml).not.toContain('summary_') // 无长程摘要预算
  // 短篇保留：style / budget.calls / auto
  expect(shortYaml).toContain('style:')
  expect(shortYaml).toContain('calls_per_chapter')
  expect(shortYaml).toContain('auto:')
})

test('stringify → parse 往返：短篇 kind 不丢', () => {
  const root = mkdtempSync(join(tmpdir(), 'yaml-kind-'))
  try {
    const cfg = { ...DEFAULT_CONFIG, kind: 'short' as const, book: { title: '集', genre: '悬疑' } }
    writeFileSync(join(root, 'book.yaml'), stringifyBookConfig(cfg), 'utf-8')
    const back = readBookConfig(join(root, 'book.yaml')).config
    expect(back.kind).toBe('short')

    // 文本里确实有 kind: short
    const text = readFileSync(join(root, 'book.yaml'), 'utf-8')
    expect(text).toMatch(/^kind: short$/m)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('short.strict: 短篇严格模式可读写，长篇不输出 short 段', () => {
  const root = mkdtempSync(join(tmpdir(), 'yaml-kind-'))
  try {
    const cfg = {
      ...DEFAULT_CONFIG,
      kind: 'short' as const,
      short: { strict: true },
      book: { title: '集', genre: '悬疑' },
    }
    const text = stringifyBookConfig(cfg)
    expect(text).toContain('short:')
    expect(text).toContain('  strict: true')

    writeFileSync(join(root, 'book.yaml'), text, 'utf-8')
    const back = readBookConfig(join(root, 'book.yaml')).config
    expect(back.short?.strict).toBe(true)

    const longYaml = stringifyBookConfig({ ...DEFAULT_CONFIG, short: { strict: true }, book: { title: '长', genre: '玄幻' } })
    expect(longYaml).not.toContain('short:')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
