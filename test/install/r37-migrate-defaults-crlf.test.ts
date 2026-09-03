/**
 * R37-23（三十七轮批 B）回归：migrate-defaults isChildKeyLine 不剥 \r。
 *
 * 根因：CRLF book.yaml 经 split('\n') 后行尾残留 \r，裸子键行（`  genre:\r`）在
 * isChildKeyLine 的 === 比对失配（带 \r 尾）、startsWith 分支也不中 → deleteSectionKey
 * 判「key 行不在」原样返回，迁移静默丢改（changed 计数与幂等重跑都看不出异常）。
 * 带值形态（`  genre: ''\r`）startsWith 从行首比、不受行尾 \r 影响，本就命中。
 * 修复：剥行尾 \r 再判（同文件 matchesKeyLineCRLF 的 Z-7 口径）。
 *
 * 平台规范化批·评审补翻（2026-09-03）：输出恒 LF——删除判定仍剥 \r（读侧容忍不变），
 * 但 migrateBookYamlText 整输出另经 canonicalizeText 归一（未触碰行的 CRLF 残尾一并
 * 剥除，与 yaml.ts 补丁族对齐）；本文件 CRLF 保真断言随翻（见各用例「归一 LF」注）。
 */
import { test, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { migrateBookDefaults } from '../../src/install/migrate-defaults.js'

let tmp: string
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'clw-r37-migrate-crlf-'))
})
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true })
})

/** 登记一本书（books.jsonl）+ 建目录写 book.yaml（口径同 migrate-defaults.test.ts） */
function makeBook(name: string, path: string, bookYaml: string): string {
  mkdirSync(join(tmp, ...path.split('/')), { recursive: true })
  const fp = join(tmp, path, 'book.yaml')
  writeFileSync(fp, bookYaml, 'utf-8')
  const reg = join(tmp, '.clwriting', 'books.jsonl')
  mkdirSync(join(tmp, '.clwriting'), { recursive: true })
  const kind = path.startsWith('短篇') ? 'short' : 'long'
  const prev = existsSync(reg) ? readFileSync(reg, 'utf-8') : ''
  writeFileSync(reg, prev + JSON.stringify({ name, path, kind }) + '\n', 'utf-8')
  return fp
}

function read(fp: string): string {
  return readFileSync(fp, 'utf8')
}

test('R37-23: CRLF 裸子键行（`  genre:\\r`）删除生效（修复前 isChildKeyLine 失配、迁移静默丢改）', () => {
  // genre 裸键（无值）解析值空串 → cfg.book.genre undefined → 触发删除条件；
  // CRLF 下该行带 \r 尾——修复前 === 比对失配，deleteSectionKey 原样返回 no-op
  const fp = makeBook('裸键书', '长篇/裸键书', [
    'spec_version: 1',
    'book:',
    '  title: 裸键书',
    '  genre:',
    '',
  ].join('\r\n'))
  const r = migrateBookDefaults(tmp)
  expect(r).toEqual({ books: 1, changed: 1, failed: 0 })
  const after = read(fp)
  expect(after).not.toContain('genre')
  // 归一 LF（评审补翻）：整输出规范化，未触碰行 CRLF 残尾一并剥除
  expect(after).not.toContain('\r')
  expect(after).toContain('title: 裸键书\n')
})

test('R37-23: CRLF 裸子键 + 带值子键混合形态（带值 startsWith 本就命中，两键都删净）', () => {
  const fp = makeBook('混合书', '长篇/混合书', [
    'spec_version: 1',
    'book:',
    '  title: 混合书',
    "  genre: ''",
    '',
    'budget:',
    '  calls_per_chapter: 8',
    '',
  ].join('\r\n'))
  migrateBookDefaults(tmp)
  const after = read(fp)
  expect(after).not.toContain('genre')
  expect(after).not.toContain('calls_per_chapter')
  expect(after).not.toContain('\r') // 归一 LF（评审补翻）
})

test('R37-23: CRLF 下带值子键删除 + 段变空整段删不回归（matchesKeyLineCRLF 既有口径）', () => {
  const fp = makeBook('整段书', '长篇/整段书', [
    'spec_version: 1',
    'book:',
    '  title: 整段书',
    '',
    'style:',
    '  injection: light',
    '',
    'growth:',
    '  realm_span_max: 2',
    '',
  ].join('\r\n'))
  migrateBookDefaults(tmp)
  const after = read(fp)
  // injection === 旧默认 light：删行后 style 段空 → 整段删（段定位/键定位两口径都在
  // CRLF 下照常）；growth 不在 13 键清单，原样保留
  expect(after).not.toContain('style:')
  expect(after).not.toContain('injection')
  expect(after).toContain('realm_span_max: 2')
  expect(after).not.toContain('\r') // 归一 LF（评审补翻）
})

test('R37-23: LF 对照不回归（裸子键照删）', () => {
  const fp = makeBook('LF书', '长篇/LF书', [
    'spec_version: 1',
    'book:',
    '  title: LF书',
    '  genre:',
    '',
  ].join('\n'))
  const r = migrateBookDefaults(tmp)
  expect(r.changed).toBe(1)
  expect(read(fp)).not.toContain('genre')
})

test('R37-23: CRLF 裸子键删除后二跑幂等（字节级无 diff）', () => {
  const fp = makeBook('幂等书', '长篇/幂等书', [
    'spec_version: 1',
    'book:',
    '  title: 幂等书',
    '  genre:',
    '',
  ].join('\r\n'))
  migrateBookDefaults(tmp)
  const once = read(fp)
  expect(once).not.toContain('\r') // 归一 LF（评审补翻）：一次迁移即剥净
  const r2 = migrateBookDefaults(tmp)
  expect(r2.changed).toBe(0)
  expect(read(fp)).toBe(once)
})
