/**
 * 书级默认值一次性迁移单测（全局托底配套）。
 *
 * 红线覆盖：文本级补丁保注释保未知段（绝不能 stringifyBookConfig 全量重生成）、
 * 值===旧默认才删（作者改过的值保留）、幂等（二跑无 diff）、损坏 yaml 跳过不崩。
 */
import { test, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { migrateBookDefaults } from '../../src/install/migrate-defaults.js'

let tmp: string
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'clw-migrate-defaults-'))
})
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true })
})

/** 登记一本书（books.jsonl）+ 建目录写 book.yaml。 */
function makeBook(name: string, path: string, bookYaml: string): string {
  mkdirSync(join(tmp, ...path.split('/')), { recursive: true })
  writeFileSync(join(tmp, path, 'book.yaml'), bookYaml, 'utf-8')
  const reg = join(tmp, '.clwriting', 'books.jsonl')
  mkdirSync(join(tmp, '.clwriting'), { recursive: true })
  const kind = path.startsWith('短篇') ? 'short' : 'long'
  const prev = existsSync(reg) ? readFileSync(reg, 'utf-8') : ''
  writeFileSync(reg, prev + JSON.stringify({ name, path, kind }) + '\n', 'utf-8')
  return join(tmp, path, 'book.yaml')
}

function read(fp: string): string {
  return readFileSync(fp, 'utf-8')
}

/** 旧 scaffold 烘焙形态的长篇 book.yaml（13 键默认值齐备 + 作者注释 + 未知段） */
const LEGACY_LONG = [
  'spec_version: 1',
  'host: cc',
  'book:',
  '  title: 旧书',
  "  genre: ''",
  '',
  'leads:',
  '  enabled: [设定线]',
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
  '# 自动化偏好（作者手写注释）',
  'auto:',
  '  confirm_outline: false',
  '  batch_size: 8',
  '  relation_auto_mine: false',
  '  relation_mine_threshold: 3',
  '',
  'growth:',
  '  realm_span_max: 2',
  '',
  '# 作者自定义未知段（文本级补丁不能丢）',
  'custom_section:',
  '  foo: bar',
  '',
].join('\n')

test('迁移：旧默认值键被删，非默认值保留，注释/未知段原样', () => {
  const fp = makeBook('旧书', '长篇/旧书', LEGACY_LONG)
  const r = migrateBookDefaults(tmp)
  expect(r).toEqual({ books: 1, changed: 1, failed: 0 })

  const after = read(fp)
  // 旧默认值键被删（值 === 旧默认）
  expect(after).not.toContain('genre')
  expect(after).not.toContain('injection')
  expect(after).not.toContain('confirm_outline')
  expect(after).not.toContain('batch_size')
  expect(after).not.toContain('calls_per_chapter')
  expect(after).not.toContain('relation_auto_mine')
  expect(after).not.toContain('relation_mine_threshold')
  // 空段连段头一起删（style/auto 段内只剩注释 → 保头保注释，段内无注释的整段删）
  // —— 本样例 auto 段上方有 0 缩进注释、段内无注释 → 整段删除但段外注释保留
  expect(after).not.toContain('style:')
  expect(after).not.toContain('auto:')
  // 非默认值 / 不在 13 键清单的键保留
  expect(after).toContain('input_per_chapter: 80000')
  expect(after).toContain('enabled: [设定线]')
  expect(after).toContain('realm_span_max: 2')
  // 作者注释 + 未知段逐字保留（文本级补丁红线——stringify 重生成会静默丢掉）
  expect(after).toContain('# 自动化偏好（作者手写注释）')
  expect(after).toContain('# 作者自定义未知段（文本级补丁不能丢）')
  expect(after).toContain('custom_section:')
  expect(after).toContain('foo: bar')
})

test('迁移：作者改过的值不删（值 ≠ 旧默认 = 有意设置）', () => {
  const fp = makeBook('改过的书', '长篇/改过的书', [
    'spec_version: 1',
    'book:',
    '  title: 改过的书',
    '  genre: 玄幻', // 非空：保留
    '',
    'budget:',
    '  calls_per_chapter: 6', // ≠8：保留
    '',
    'style:',
    '  injection: heavy', // ≠light：保留
    '',
    'auto:',
    '  confirm_outline: true', // ≠false：保留
    '  batch_size: 8', // ===8：删
    '',
  ].join('\n'))
  const r = migrateBookDefaults(tmp)
  expect(r.changed).toBe(1)
  const after = read(fp)
  expect(after).toContain('genre: 玄幻')
  expect(after).toContain('calls_per_chapter: 6')
  expect(after).toContain('injection: heavy')
  expect(after).toContain('confirm_outline: true')
  expect(after).not.toContain('batch_size')
})

test('迁移：短篇 batch_size: 1 是有意产品默认，不删', () => {
  const fp = makeBook('短篇集', '短篇/短篇集', [
    'spec_version: 1',
    'kind: short',
    'book:',
    '  title: 夜语集',
    "  genre: ''", // 空占位：删
    '',
    'short:',
    '  strict: false', // ===旧默认：删
    '',
    'auto:',
    '  batch_size: 1', // 短篇逐篇确认：保留
    '',
  ].join('\n'))
  migrateBookDefaults(tmp)
  const after = read(fp)
  expect(after).toContain('batch_size: 1')
  expect(after).not.toContain('strict')
  expect(after).not.toContain('genre')
})

test('迁移：rag 段恰为 {enabled:false} 纯净态才整段删；带配置的保留', () => {
  const pure = makeBook('纯净rag', '长篇/纯净rag', [
    'spec_version: 1',
    'book:',
    '  title: 纯净rag',
    '',
    'rag:',
    '  enabled: false',
    '',
  ].join('\n'))
  const configured = makeBook('配置rag', '长篇/配置rag', [
    'spec_version: 1',
    'book:',
    '  title: 配置rag',
    '',
    'rag:',
    '  enabled: false',
    '  provider: rag-abc', // 有服务商引用：整段保留
    '',
  ].join('\n'))
  migrateBookDefaults(tmp)
  expect(read(pure)).not.toMatch(/^rag:/m)
  expect(read(configured)).toContain('rag:')
  expect(read(configured)).toContain('provider: rag-abc')
})

test('迁移：幂等——二跑无 diff（文件字节级不变）', () => {
  const fp = makeBook('旧书', '长篇/旧书', LEGACY_LONG)
  migrateBookDefaults(tmp)
  const once = read(fp)
  const r2 = migrateBookDefaults(tmp)
  expect(r2.changed).toBe(0) // 二跑零改写
  expect(read(fp)).toBe(once) // 文件字节级不变
})

test('迁移：损坏 yaml 跳过不崩（原文件不动，不阻断其他书）', () => {
  const broken = makeBook('坏书', '长篇/坏书', 'spec_version: [unclosed')
  const good = makeBook('好书', '长篇/好书', LEGACY_LONG)
  const r = migrateBookDefaults(tmp)
  expect(r.books).toBe(2)
  expect(r.changed).toBe(1) // 好书照常迁移
  expect(read(broken)).toBe('spec_version: [unclosed') // 坏书原样
  expect(read(good)).not.toContain('calls_per_chapter')
})

test('迁移：无 book.yaml 的登记残留书跳过不报错', () => {
  makeBook('幽灵书', '长篇/幽灵书', 'spec_version: 1\nbook:\n  title: T\n')
  // 删掉 book.yaml 再迁移（登记还在）
  rmSync(join(tmp, '长篇/幽灵书'), { recursive: true, force: true })
  const r = migrateBookDefaults(tmp)
  expect(r).toEqual({ books: 1, changed: 0, failed: 0 })
})

test('迁移：段变空只剩段内注释时保头保注释（注释不陪葬）', () => {
  const fp = makeBook('注释书', '长篇/注释书', [
    'spec_version: 1',
    'book:',
    '  title: 注释书',
    '',
    'style:',
    '  # 作者解释为什么用轻注入',
    '  injection: light',
    '',
  ].join('\n'))
  migrateBookDefaults(tmp)
  const after = read(fp)
  // injection 是旧默认被删；段内注释保留 + 段头保留（yaml 合法空段）
  expect(after).toContain('# 作者解释为什么用轻注入')
  expect(after).toContain('style:')
  expect(after).not.toContain('injection')
})

test('迁移：整段删除后段间空行归整（无双空行、结尾不堆积）', () => {
  const fp = makeBook('空行书', '长篇/空行书', [
    'spec_version: 1',
    'book:',
    '  title: 空行书',
    '',
    'style:',
    '  injection: light',
    '',
    'growth:',
    '  realm_span_max: 2',
    '',
  ].join('\n'))
  migrateBookDefaults(tmp)
  const after = read(fp)
  expect(after).not.toContain('style:')
  expect(after).not.toMatch(/\n\n\n/) // 无三连换行（双空行）
  expect(after.endsWith('\n')).toBe(true)
  expect(after).toContain('realm_span_max: 2')
})
