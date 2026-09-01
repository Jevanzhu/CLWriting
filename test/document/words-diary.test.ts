/**
 * 字数日记单测（§5.4 今日基线）。
 * 覆盖：无日记返 null、append+read 往返、一日多条取最后（多端打开）、todayDate 格式。
 */
import { test, expect } from 'vitest'
import { rmSync, readFileSync, existsSync, appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readBaseline, appendBaseline, readTodayDelta, appendWordsDelta, todayDate, wordsDiaryPath } from '../../src/document/words-diary.js'
import { mkdtempTracked } from '../helpers/temp-dir.js'

test('readBaseline: 无日记返 null', () => {
  const root = mkdtempTracked(join(tmpdir(), 'w-diary-'))
  expect(readBaseline(root, '2026-07-24')).toBeNull()
  rmSync(root, { recursive: true, force: true })
})

test('appendBaseline + readBaseline: 记今日基线并读回；其他日无', () => {
  const root = mkdtempTracked(join(tmpdir(), 'w-diary-'))
  appendBaseline(root, '2026-07-24', 12345)
  expect(readBaseline(root, '2026-07-24')).toBe(12345)
  expect(readBaseline(root, '2026-07-23')).toBeNull()
  // 落到 项目/字数日记.jsonl
  expect(existsSync(wordsDiaryPath(root))).toBe(true)
  rmSync(root, { recursive: true, force: true })
})

test('appendBaseline: 一日多条取最后（多端打开场景）', () => {
  const root = mkdtempTracked(join(tmpdir(), 'w-diary-'))
  appendBaseline(root, '2026-07-24', 100)
  appendBaseline(root, '2026-07-24', 200)
  expect(readBaseline(root, '2026-07-24')).toBe(200)
  rmSync(root, { recursive: true, force: true })
})

test('readBaseline: 跳过坏行（容错）', () => {
  const root = mkdtempTracked(join(tmpdir(), 'w-diary-'))
  appendBaseline(root, '2026-07-24', 999)
  // 手动插一行坏 JSON
  const fp = wordsDiaryPath(root)
  const raw = readFileSync(fp, 'utf-8')
  appendFileSync(fp, '{坏行\n' + raw, 'utf-8')
  expect(readBaseline(root, '2026-07-24')).toBe(999)
  rmSync(root, { recursive: true, force: true })
})

test('todayDate: 本地时区 YYYY-MM-DD', () => {
  const d = new Date()
  const expected = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  expect(todayDate()).toBe(expected)
})

// ── E4：精确增量 ────────────────────────────────

test('readTodayDelta: 无记录返 null', () => {
  const root = mkdtempTracked(join(tmpdir(), 'w-delta-'))
  expect(readTodayDelta(root, '2026-07-24')).toBeNull()
  rmSync(root, { recursive: true, force: true })
})

test('appendWordsDelta + readTodayDelta: 当日多次累加（含负 delta）', () => {
  const root = mkdtempTracked(join(tmpdir(), 'w-delta-'))
  appendWordsDelta(root, '2026-07-24', 500, 'doc_a')
  appendWordsDelta(root, '2026-07-24', -100, 'doc_a') // 删减
  appendWordsDelta(root, '2026-07-24', 300, 'doc_b')
  expect(readTodayDelta(root, '2026-07-24')).toBe(700) // 500 - 100 + 300
  rmSync(root, { recursive: true, force: true })
})

test('readTodayDelta: 跨日归日（他日 delta 不入今日）', () => {
  const root = mkdtempTracked(join(tmpdir(), 'w-delta-'))
  appendWordsDelta(root, '2026-07-23', 999)
  appendWordsDelta(root, '2026-07-24', 42)
  expect(readTodayDelta(root, '2026-07-24')).toBe(42)
  expect(readTodayDelta(root, '2026-07-23')).toBe(999)
  rmSync(root, { recursive: true, force: true })
})

test('readTodayDelta: 与 baseline 条目共存（baseline 不影响 delta 汇总）', () => {
  const root = mkdtempTracked(join(tmpdir(), 'w-delta-'))
  appendBaseline(root, '2026-07-24', 12345) // baseline 条目（无 delta 字段）
  appendWordsDelta(root, '2026-07-24', 200)
  appendBaseline(root, '2026-07-24', 13000) // 多端再记 baseline
  expect(readTodayDelta(root, '2026-07-24')).toBe(200) // 只算 delta 条目
  expect(readBaseline(root, '2026-07-24')).toBe(13000) // baseline 仍正常取最后
  rmSync(root, { recursive: true, force: true })
})

// ── R34D-13：倒序首个同日命中是 delta 行时不得返回 undefined ────

test('R34D-13: 基线在前 delta 在后（真实时序）→ readBaseline 返回基线而非 undefined', () => {
  const root = mkdtempTracked(join(tmpdir(), 'w-diary-r34d-'))
  try {
    // 真实时序：晨记基线 → 日间多次 save 落 delta（同日尾部是 delta 行）
    appendBaseline(root, '2026-07-24', 10000)
    appendWordsDelta(root, '2026-07-24', 500)
    appendWordsDelta(root, '2026-07-24', -80)
    // 修复前：倒序首个同日命中是尾部 delta 行（无 baseline 字段）→ 返回 undefined
    const r = readBaseline(root, '2026-07-24')
    expect(r).toBe(10000) // 契约 number | null：既非 undefined 也非 null
    expect(r).not.toBeUndefined()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('R34D-13: 当日只有 delta 行（无基线）→ 返回 null（契约兜底，非 undefined）', () => {
  const root = mkdtempTracked(join(tmpdir(), 'w-diary-r34d-'))
  try {
    appendWordsDelta(root, '2026-07-24', 300)
    const r = readBaseline(root, '2026-07-24')
    expect(r).toBeNull()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
