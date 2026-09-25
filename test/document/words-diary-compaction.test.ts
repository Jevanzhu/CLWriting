/**
 * PM-5（性能与内存专项）回归：字数日记跨日 compaction。
 *
 * append-only jsonl 超阈值后在 appendBaseline（每日首基线低频时机）触发跨日压缩：
 * 历史日归并为每日至多两行（最后基线 + delta 总和/末 delta 的 ts），今日/未来行
 * 原样保留，坏行移尾保审计。本文件锚定：压缩前后 readBaseline/readTodayDelta 对
 * 历史日逐位一致、今日行未动、行数大幅减少、默认阈值门（真实 >1MB 文件）+
 * 注入阈值 0 强制触发、坏行不炸、压缩产物再压缩幂等。
 */
import { test, expect } from 'vitest'
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  appendBaseline,
  readBaseline,
  readTodayDelta,
  wordsDiaryPath,
  WORDS_DIARY_COMPACT_BYTES,
  __setWordsDiaryCompactBytesForTest,
} from '../../src/document/words-diary.js'
import { mkdtempTracked } from '../helpers/temp-dir.js'

/** 直接落一份原始 jsonl（绕过 append API，自由构造多日/坏行形态——R47 测试同款）。 */
function writeRawDiary(root: string, lines: string[]): void {
  mkdirSync(join(root, '项目'), { recursive: true })
  writeFileSync(wordsDiaryPath(root), lines.map((l) => l + '\n').join(''), 'utf-8')
}

/** 读回非空行列表。 */
function readLines(fp: string): string[] {
  return readFileSync(fp, 'utf-8').split('\n').filter(Boolean)
}

test('PM-5: 多日多 delta 超 1MB 默认阈值压缩——逐日语义等价 + 今日行未动 + 行数大幅减少', () => {
  const root = mkdtempTracked(join(tmpdir(), 'w-diary-pm5-'))
  try {
    const T = '2026-09-05'
    const N = 3000
    const dayKey = (offset: number): string => {
      // 末历史日 2026-09-04 往回数 N-1 天（Date 自动归一化负日字段）——保证全部历史日 < T
      const d = new Date(2026, 8, 4 - (N - 1 - offset))
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    }
    // 3000 个历史日，每日 1 baseline + 6 delta（带 docId）≈ 1.2MB（超默认阈值 1MB）
    const lines: string[] = []
    for (let i = 0; i < N; i++) {
      const d = dayKey(i)
      lines.push(JSON.stringify({ date: d, baseline: 10000 + i }))
      for (let j = 0; j < 6; j++) {
        // 当日 delta 之和 = (50 + i) - 3 - 6 - 9 - 12 - 15 = 5 + i；末条 ts = `t${i}-5`
        lines.push(JSON.stringify({ date: d, delta: j === 0 ? 50 + i : -(j * 3), ts: `t${i}-${j}`, docId: `doc-${i}` }))
      }
    }
    // 今日已有 delta + 首条基线（真实时序：晨基线前先有跨零点 save 的可能）
    const todayRows = [
      JSON.stringify({ date: T, delta: 11, ts: 'today-1', docId: 'd-today' }),
      JSON.stringify({ date: T, baseline: 424242 }),
    ]
    lines.push(...todayRows)
    writeRawDiary(root, lines)
    const fp = wordsDiaryPath(root)
    expect(statSync(fp).size).toBeGreaterThan(WORDS_DIARY_COMPACT_BYTES) // 确认真超默认阈值
    const preLineCount = readLines(fp).length

    // 压缩前锚定：抽样历史日的两读函数返回值（压缩后须逐位一致）
    const samples = [0, 1, Math.floor(N / 2), N - 2, N - 1]
    const preB = new Map(samples.map((i) => [i, readBaseline(root, dayKey(i))]))
    const preD = new Map(samples.map((i) => [i, readTodayDelta(root, dayKey(i))]))

    // 触发：写今日第二条基线（多端打开形态）→ appendBaseline 内部检测 ≥ 阈值 → 压缩
    appendBaseline(root, T, 424243)

    const post = readLines(fp)
    // 行数：历史 2000 日 × 2 行 + 今日 3 行（原 2 行原样 + 新基线），大幅减少
    expect(post.length).toBe(2 * N + 3)
    expect(post.length).toBeLessThan(preLineCount / 3)
    // 历史区首日两行的逐字节形态（docId 省略、ts 取该日末条 delta 的 ts）
    expect(post[0]).toBe(JSON.stringify({ date: dayKey(0), baseline: 10000 }))
    expect(post[1]).toBe(JSON.stringify({ date: dayKey(0), delta: 5, ts: 't0-5' }))
    expect(post[1]).not.toContain('docId')
    // 今日行未动（原样原序）+ 新基线行落在今日区末尾
    expect(post.slice(-3)).toEqual([...todayRows, JSON.stringify({ date: T, baseline: 424243 })])
    // 压缩后逐位等价：抽样历史日两读函数与压缩前一致
    for (const i of samples) {
      expect(readBaseline(root, dayKey(i))).toBe(preB.get(i))
      expect(readTodayDelta(root, dayKey(i))).toBe(preD.get(i))
    }
    // 绝对值锚定（防「两侧一起错」）：日 0 与日 N-1
    expect(readBaseline(root, dayKey(0))).toBe(10000)
    expect(readTodayDelta(root, dayKey(0))).toBe(5)
    expect(readBaseline(root, dayKey(N - 1))).toBe(10000 + N - 1)
    expect(readTodayDelta(root, dayKey(N - 1))).toBe(5 + N - 1)
    // 今日读侧：基线取最后、delta 原样
    expect(readBaseline(root, T)).toBe(424243)
    expect(readTodayDelta(root, T)).toBe(11)
    // 压缩用锁已释放（无 .lock 残留）
    expect(existsSync(`${fp}.lock`)).toBe(false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('PM-5: 文件小于默认阈值不压缩——原样 + 只追加新基线行，无锁副作用', () => {
  const root = mkdtempTracked(join(tmpdir(), 'w-diary-pm5-small-'))
  try {
    const lines = [
      JSON.stringify({ date: '2026-09-03', baseline: 10 }),
      JSON.stringify({ date: '2026-09-03', delta: 4, ts: 'a' }),
      JSON.stringify({ date: '2026-09-04', baseline: 20 }),
    ]
    writeRawDiary(root, lines)
    const fp = wordsDiaryPath(root)
    const before = readFileSync(fp, 'utf-8')
    appendBaseline(root, '2026-09-05', 30)
    // 未超阈值：文件 = 原内容 + 新基线行，逐字节不变
    expect(readFileSync(fp, 'utf-8')).toBe(before + JSON.stringify({ date: '2026-09-05', baseline: 30 }) + '\n')
    // 阈值门前短路——连锁文件都不应创建
    expect(existsSync(`${fp}.lock`)).toBe(false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('PM-5: 坏行（parse 失败/无 date）移至尾部保审计，不炸且读侧等价', () => {
  __setWordsDiaryCompactBytesForTest(0) // 注入 0 强制触发
  const root = mkdtempTracked(join(tmpdir(), 'w-diary-pm5-bad-'))
  try {
    const lines = [
      '{坏行-头',
      JSON.stringify({ date: '2026-09-01', baseline: 100 }),
      JSON.stringify({ noDate: true, delta: 999 }), // 无 date 字段的外来行
      JSON.stringify({ date: '2026-09-01', delta: 7, ts: 'a', docId: 'x' }),
      JSON.stringify({ date: '2026-09-02', delta: -2, ts: 'b' }),
      '{"date":"2026-09-0', // 崩溃半写截断的末行（parse 必败）
      JSON.stringify({ date: '2026-09-05', delta: 5, ts: 'c' }),
    ]
    writeRawDiary(root, lines)
    const fp = wordsDiaryPath(root)
    appendBaseline(root, '2026-09-05', 42) // 触发压缩，不得抛
    // 历史两日归并（09-02 无 baseline 行 → 省略该行）→ 今日行原样 → 坏行按原相对顺序移尾
    expect(readLines(fp)).toEqual([
      JSON.stringify({ date: '2026-09-01', baseline: 100 }),
      JSON.stringify({ date: '2026-09-01', delta: 7, ts: 'a' }),
      JSON.stringify({ date: '2026-09-02', delta: -2, ts: 'b' }),
      JSON.stringify({ date: '2026-09-05', delta: 5, ts: 'c' }),
      JSON.stringify({ date: '2026-09-05', baseline: 42 }),
      '{坏行-头',
      JSON.stringify({ noDate: true, delta: 999 }),
      '{"date":"2026-09-0',
    ])
    // 读侧等价
    expect(readBaseline(root, '2026-09-01')).toBe(100)
    expect(readTodayDelta(root, '2026-09-01')).toBe(7)
    expect(readBaseline(root, '2026-09-02')).toBeNull()
    expect(readTodayDelta(root, '2026-09-02')).toBe(-2)
    expect(readBaseline(root, '2026-09-05')).toBe(42)
    expect(readTodayDelta(root, '2026-09-05')).toBe(5)
  } finally {
    __setWordsDiaryCompactBytesForTest(WORDS_DIARY_COMPACT_BYTES)
    rmSync(root, { recursive: true, force: true })
  }
})

test('PM-5: 注入阈值 0 强制触发——边缘形态（仅 baseline 日/仅 delta 日/多 baseline 取最后/末条 delta 缺 ts）', () => {
  __setWordsDiaryCompactBytesForTest(0)
  const root = mkdtempTracked(join(tmpdir(), 'w-diary-pm5-edge-'))
  try {
    const lines = [
      JSON.stringify({ date: '2026-09-01', baseline: 1 }), // 仅 baseline 日
      JSON.stringify({ date: '2026-09-01', baseline: 2 }), // 同日再记 → 取最后
      JSON.stringify({ date: '2026-09-02', delta: 5, ts: 'z' }), // 仅 delta 日
      JSON.stringify({ date: '2026-09-02', delta: -8 }), // 末条 delta 缺 ts → 输出省略 ts
    ]
    writeRawDiary(root, lines)
    const fp = wordsDiaryPath(root)
    // 压缩前锚定
    const preB1 = readBaseline(root, '2026-09-01')
    const preD1 = readTodayDelta(root, '2026-09-01')
    const preB2 = readBaseline(root, '2026-09-02')
    const preD2 = readTodayDelta(root, '2026-09-02')
    appendBaseline(root, '2026-09-05', 9) // 触发
    expect(readLines(fp)).toEqual([
      JSON.stringify({ date: '2026-09-01', baseline: 2 }), // 仅 baseline 行
      JSON.stringify({ date: '2026-09-02', delta: -3 }), // 仅 delta 行，5 + (-8)，无 ts
      JSON.stringify({ date: '2026-09-05', baseline: 9 }),
    ])
    expect(readBaseline(root, '2026-09-01')).toBe(preB1) // 2
    expect(readTodayDelta(root, '2026-09-01')).toBe(preD1) // null
    expect(readBaseline(root, '2026-09-02')).toBe(preB2) // null
    expect(readTodayDelta(root, '2026-09-02')).toBe(preD2) // -3
  } finally {
    __setWordsDiaryCompactBytesForTest(WORDS_DIARY_COMPACT_BYTES)
    rmSync(root, { recursive: true, force: true })
  }
})

test('PM-5: 压缩产物再压缩幂等——第二轮触发对既有行零改动', () => {
  __setWordsDiaryCompactBytesForTest(0)
  const root = mkdtempTracked(join(tmpdir(), 'w-diary-pm5-idem-'))
  try {
    writeRawDiary(root, [
      JSON.stringify({ date: '2026-09-03', baseline: 10 }),
      JSON.stringify({ date: '2026-09-03', delta: 1, ts: 'a' }),
      JSON.stringify({ date: '2026-09-03', delta: 2, ts: 'b' }),
      JSON.stringify({ date: '2026-09-04', delta: 3, ts: 'c' }),
    ])
    const fp = wordsDiaryPath(root)
    appendBaseline(root, '2026-09-05', 5) // 第一轮
    const after1 = readFileSync(fp, 'utf-8')
    expect(after1).toBe(
      [
        JSON.stringify({ date: '2026-09-03', baseline: 10 }),
        JSON.stringify({ date: '2026-09-03', delta: 3, ts: 'b' }),
        JSON.stringify({ date: '2026-09-04', delta: 3, ts: 'c' }),
        JSON.stringify({ date: '2026-09-05', baseline: 5 }),
      ]
        .map((l) => l + '\n')
        .join(''),
    )
    // 第二轮：今日再记一条基线再触发——既有行必须逐字节不变（只追加新基线行）
    appendBaseline(root, '2026-09-05', 6)
    expect(readFileSync(fp, 'utf-8')).toBe(after1 + JSON.stringify({ date: '2026-09-05', baseline: 6 }) + '\n')
    // 读侧仍等价
    expect(readBaseline(root, '2026-09-03')).toBe(10)
    expect(readTodayDelta(root, '2026-09-03')).toBe(3)
    expect(readTodayDelta(root, '2026-09-04')).toBe(3)
    expect(readBaseline(root, '2026-09-05')).toBe(6)
  } finally {
    __setWordsDiaryCompactBytesForTest(WORDS_DIARY_COMPACT_BYTES)
    rmSync(root, { recursive: true, force: true })
  }
})
