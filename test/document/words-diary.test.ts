/**
 * 字数日记单测（§5.4 今日基线）。
 * 覆盖：无日记返 null、append+read 往返、一日多条取最后（多端打开）、todayDate 格式。
 */
import { test, expect } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, existsSync, appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readBaseline, appendBaseline, todayDate, wordsDiaryPath } from '../../src/document/words-diary.js'

test('readBaseline: 无日记返 null', () => {
  const root = mkdtempSync(join(tmpdir(), 'w-diary-'))
  expect(readBaseline(root, '2026-07-24')).toBeNull()
  rmSync(root, { recursive: true, force: true })
})

test('appendBaseline + readBaseline: 记今日基线并读回；其他日无', () => {
  const root = mkdtempSync(join(tmpdir(), 'w-diary-'))
  appendBaseline(root, '2026-07-24', 12345)
  expect(readBaseline(root, '2026-07-24')).toBe(12345)
  expect(readBaseline(root, '2026-07-23')).toBeNull()
  // 落到 项目/字数日记.jsonl
  expect(existsSync(wordsDiaryPath(root))).toBe(true)
  rmSync(root, { recursive: true, force: true })
})

test('appendBaseline: 一日多条取最后（多端打开场景）', () => {
  const root = mkdtempSync(join(tmpdir(), 'w-diary-'))
  appendBaseline(root, '2026-07-24', 100)
  appendBaseline(root, '2026-07-24', 200)
  expect(readBaseline(root, '2026-07-24')).toBe(200)
  rmSync(root, { recursive: true, force: true })
})

test('readBaseline: 跳过坏行（容错）', () => {
  const root = mkdtempSync(join(tmpdir(), 'w-diary-'))
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
