/**
 * R47-25（四十七轮）回归：readTodayDelta 倒序扫描——行按日期 append 序，从文件尾
 * 累计目标日行、遇首条「日期 < 目标日」的完好行即停（O(当日行数)，不再逐行 parse
 * 全部历史）。日期 > 目标日的行跳过不停扫，保证历史日期查询与正序全量求和逐位一致
 * （既有「跨日归日」用例锚定的契约）。本文件用混合日期 + 坏行夹具，把倒序实现与
 * 测试内正序参考实现对照求值等价，另覆盖坏行容错与截断尾行。
 */
import { test, expect } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readTodayDelta, wordsDiaryPath } from '../../src/document/words-diary.js'
import { mkdtempTracked } from '../helpers/temp-dir.js'

/** 正序参考实现（R47-25 改前的原实现，逐字复制）——等价性对照基准。 */
function forwardRef(lines: string[], date: string): number | null {
  let sum = 0
  let found = false
  for (const line of lines) {
    if (!line) continue
    try {
      const rec = JSON.parse(line) as { date?: unknown; delta?: unknown }
      if (rec.date === date && typeof rec.delta === 'number') {
        sum += rec.delta
        found = true
      }
    } catch {
      // 跳过坏行
    }
  }
  return found ? sum : null
}

/** 直接落一份原始 jsonl（绕过 append API，自由构造混合日期/坏行形态）。 */
function writeRawDiary(root: string, lines: string[]): void {
  mkdirSync(join(root, '项目'), { recursive: true })
  writeFileSync(wordsDiaryPath(root), lines.map((l) => l + '\n').join(''), 'utf-8')
}

test('R47-25: 混合日期 + 坏行文件——倒序与正序参考实现对全部日期逐位等价', () => {
  const root = mkdtempTracked(join(tmpdir(), 'w-diary-r47-'))
  try {
    const D1 = '2026-09-03'
    const D2 = '2026-09-04'
    const D3 = '2026-09-05'
    // append 序：D1 块（坏行夹中）→ D2 块（baseline/delta 共存）→ D3 块（截断坏尾行）
    const lines = [
      '{坏行',
      JSON.stringify({ date: D1, baseline: 10000 }),
      JSON.stringify({ date: D1, delta: 120, ts: 't', docId: 'a' }),
      JSON.stringify({ date: D1, delta: -30, ts: 't' }),
      JSON.stringify({ date: D2, baseline: 11000 }),
      JSON.stringify({ date: D2, delta: 55, ts: 't' }),
      JSON.stringify({ date: D3, delta: 7, ts: 't' }),
      JSON.stringify({ date: D3, baseline: 12000 }),
      JSON.stringify({ date: D3, delta: -2, ts: 't' }),
      '{"date":"2026-09-0', // 崩溃半写截断的末行（parse 必败）
      JSON.stringify({ noDate: true, delta: 999 }), // 无 date 字段的外来行
    ]
    writeRawDiary(root, lines)
    // 查最新日（倒序主路径：尾部累计 + 更早日期停扫）与历史日（穿透 > 目标日的尾部行）
    for (const d of [D1, D2, D3]) {
      expect(readTodayDelta(root, d)).toBe(forwardRef(lines, d))
    }
    expect(readTodayDelta(root, D3)).toBe(5) // 7 - 2（坏尾行/无 date 行不计入）
    expect(readTodayDelta(root, D2)).toBe(55)
    expect(readTodayDelta(root, D1)).toBe(90) // 120 - 30
    // 无该日条目 → null（含目标日晚于文件全部日期的形态）
    expect(readTodayDelta(root, '2026-09-06')).toBeNull()
    expect(readTodayDelta(root, '2026-09-01')).toBeNull()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('R47-25: 全文件皆目标日（无停扫点）与空行容错', () => {
  const root = mkdtempTracked(join(tmpdir(), 'w-diary-r47-'))
  try {
    const D = '2026-09-05'
    const lines = [
      JSON.stringify({ date: D, delta: 1 }),
      '', // 空行（split('\n') 中段空串形态）
      JSON.stringify({ date: D, delta: 2 }),
    ]
    writeRawDiary(root, lines)
    expect(readTodayDelta(root, D)).toBe(3)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('R47-25: 只写 baseline（无 delta 条目）→ null 与正序参考一致', () => {
  const root = mkdtempTracked(join(tmpdir(), 'w-diary-r47-'))
  try {
    const D = '2026-09-05'
    const lines = [JSON.stringify({ date: D, baseline: 100 }), JSON.stringify({ date: D, baseline: 200 })]
    writeRawDiary(root, lines)
    expect(readTodayDelta(root, D)).toBeNull()
    expect(readTodayDelta(root, D)).toBe(forwardRef(lines, D))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('R47-25: 大历史前置 + 当日尾部——当日求值不受历史长度影响（等价抽查）', () => {
  const root = mkdtempTracked(join(tmpdir(), 'w-diary-r47-'))
  try {
    const D = '2026-09-05'
    const lines: string[] = []
    // 60 天严格递增历史（每天 baseline + delta），全部早于目标日 → 倒序扫过当日块后
    // 在首个历史行即停，不必 parse 更早历史
    const dayKey = (offset: number): string => {
      const d = new Date(2026, 6, 7 + offset) // 2026-07-07 起本地日
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    }
    for (let i = 0; i < 60; i++) {
      const d = dayKey(i)
      lines.push(JSON.stringify({ date: d, baseline: i }))
      lines.push(JSON.stringify({ date: d, delta: i }))
    }
    lines.push(JSON.stringify({ date: D, delta: 11 }))
    lines.push(JSON.stringify({ date: D, delta: 22 }))
    writeRawDiary(root, lines)
    expect(readTodayDelta(root, D)).toBe(33)
    expect(readTodayDelta(root, D)).toBe(forwardRef(lines, D))
    // 历史日抽查（尾部 D 行在目标日之后：倒序须跳过不停扫）
    expect(readTodayDelta(root, dayKey(0))).toBe(0)
    expect(readTodayDelta(root, dayKey(0))).toBe(forwardRef(lines, dayKey(0)))
    expect(readTodayDelta(root, dayKey(59))).toBe(59)
    expect(readTodayDelta(root, dayKey(59))).toBe(forwardRef(lines, dayKey(59)))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// 直接 mkdtemp 的兜底清理（mkdtempTracked 之外确保无残留——与同目录测试同款 try/finally 习惯）
test('R47-25: 无日记文件 → null（原语义保持）', () => {
  const root = mkdtempSync(join(tmpdir(), 'w-diary-r47-empty-'))
  try {
    expect(readTodayDelta(root, '2026-09-05')).toBeNull()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
