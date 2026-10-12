/**
 * 字数日记单测（§5.4 今日基线）。
 * 覆盖：无日记返 null、append+read 往返、一日多条取最后（多端打开）、todayDate 格式。
 */
import { test, expect, describe, vi } from 'vitest'
import { rmSync, readFileSync, existsSync, appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  readBaseline,
  appendBaseline,
  readTodayDelta,
  appendWordsDelta,
  todayDate,
  wordsDiaryPath,
} from '../../src/document/words-diary.js'
import { mkdtempTracked } from '../helpers/temp-dir.js'
import { denyRead } from '../helpers/fs-deny.js'

// win 臂 EACCES 注入的模块包装（posix 臂走 chmod 不依赖此包装；未登记拒绝时全透传）
// ——见 helpers/fs-deny.ts 头注。
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  const { armFsNamespace } = await import('../helpers/fs-deny.js')
  return armFsNamespace('fs', actual) as typeof actual
})
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  const { armFsNamespace } = await import('../helpers/fs-deny.js')
  return armFsNamespace('fsp', actual) as typeof actual
})
// 追加后 fsync 计数：拦截 words-diary → journal 的 fsyncFile 调用（ESM 命名导出无法
// spyOn，mock 工厂透传原实现 + 计数）。与上方的 node:fs 包装互不相干（不同模块）。
const fsyncSpy = vi.hoisted(() => vi.fn())
vi.mock('../../src/document/journal.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../src/document/journal.js')>()
  return {
    ...orig,
    fsyncFile: (...args: Parameters<typeof orig.fsyncFile>) => {
      fsyncSpy(...args)
      return orig.fsyncFile(...args)
    },
  }
})

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

// ── 字数日记读失败降级：readBaseline / readTodayDelta 原先 readFileSync 失败（权限/磁盘）
// 直接抛 EACCES，打断上层字数统计流程；修复后返回 null（视作无记录）。读失败注入走
// helpers/fs-deny.ts 单源平台分派（posix 臂 chmod 0o000；win 臂经 vi.mock 包装按产品读取
// 函数注入 EACCES），win 生产高发形态（杀毒/索引器拒读）本机真跑。──

test('日记文件读失败（权限）→ readBaseline/readTodayDelta 返 null 不抛', () => {
  const root = mkdtempTracked(join(tmpdir(), 'w-diary-fail-'))
  appendBaseline(root, '2026-08-21', 100)
  appendWordsDelta(root, '2026-08-21', 50)
  const deny = denyRead(wordsDiaryPath(root)) // 挡读（清库/恢复窗口的典型形态）
  try {
    expect(readBaseline(root, '2026-08-21')).toBeNull()
    expect(readTodayDelta(root, '2026-08-21')).toBeNull()
  } finally {
    deny.restore()
    rmSync(root, { recursive: true, force: true })
  }
})

// ── 字数日记追加后 best-effort fsync：appendWordsDelta / appendBaseline 裸 appendFileSync
// 无 fsync——对照同为 append-only 的 journal appendLineAsync（追加后 fsyncFile）的耐久
// 纪律，掉电丢尾部行虽有读侧逐行容错自愈，但压缩损失面是白给的。修法：追加后复用
// journal.fsyncFile（单源导出，勿复制实现；吞错同口径 best-effort）。断言形态 = 拦截
// words-diary → journal 的 fsyncFile 调用（修复前该调用不发生 → 红）。──

describe('字数日记追加后 fsync', () => {
  /** 本次根上日记文件的 fsync 调用次数（排除他路径噪音）。 */
  function fsyncCallsOn(root: string): number {
    return fsyncSpy.mock.calls.filter((c) => c[0] === wordsDiaryPath(root)).length
  }

  test('appendWordsDelta 追加后 fsync 一次（journal.fsyncFile 单源复用）', () => {
    const root = mkdtempTracked(join(tmpdir(), 'w-diary-fsync-'))
    try {
      fsyncSpy.mockClear()
      appendWordsDelta(root, '2026-09-18', 42, 'doc-1')
      expect(fsyncCallsOn(root)).toBe(1)
      // 行本体照常落盘（fsync 不改写入语义）
      const fp = wordsDiaryPath(root)
      expect(existsSync(fp)).toBe(true)
      expect(readFileSync(fp, 'utf-8')).toContain('"delta":42')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('appendBaseline 追加后同样 fsync（基线行耐久同纪律）', () => {
    const root = mkdtempTracked(join(tmpdir(), 'w-diary-fsync-'))
    try {
      fsyncSpy.mockClear()
      appendBaseline(root, '2026-09-18', 12345)
      expect(fsyncCallsOn(root)).toBe(1)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
