/**
 * R0910-W（2026-09-10 修复批）回归：housekeeping 兜底清扫 30 天前 spill。
 *
 * 原 sweepOldSpills 只在 writeSpillFile 热路径触发——一本书写完再无编辑时旧 spill
 * 永久残留。修复：接线到 state.ts 的节流 housekeeping（sweepAbandonedTmpFilesThrottled
 * 同窗）。本用例造一个 40 天前与一个当下的 spill 文件，断言 detectState 首扫（节流表
 * 空）清掉超龄者、保留新鲜者。
 */
import { test, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { detectState, __resetSweepThrottleForTest } from '../../src/state/state.js'
import { writeBookConfig, DEFAULT_CONFIG } from '../../src/format/yaml.js'
import type { BookConfig } from '../../src/format/types.js'

const SHORT_CONFIG: BookConfig = { ...DEFAULT_CONFIG, kind: 'short', book: { title: 'spill 书', genre: '悬疑' } }
let root = ''

beforeEach(() => {
  __resetSweepThrottleForTest()
  root = mkdtempSync(join(tmpdir(), 'r0910-spill-'))
  writeBookConfig(join(root, 'book.yaml'), SHORT_CONFIG)
  mkdirSync(join(root, '写作', '正文'), { recursive: true })
  mkdirSync(join(root, '工作区', 'spills'), { recursive: true })
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

test('R0910-W: detectState 兜底清扫超龄 spill，保留新鲜 spill', async () => {
  const stale = join(root, '工作区', 'spills', 'old.md')
  const staleMeta = join(root, '工作区', 'spills', 'old.meta.json')
  const fresh = join(root, '工作区', 'spills', 'new.md')
  writeFileSync(stale, 'stale spill', 'utf8')
  writeFileSync(staleMeta, '{}', 'utf8')
  writeFileSync(fresh, 'fresh spill', 'utf8')
  const old = new Date(Date.now() - 40 * 24 * 60 * 60_000) // 40 天前，超 30 天 TTL
  utimesSync(stale, old, old)
  utimesSync(staleMeta, old, old)

  await detectState(root, SHORT_CONFIG)

  expect(existsSync(stale)).toBe(false)
  expect(existsSync(staleMeta)).toBe(false)
  expect(existsSync(fresh)).toBe(true)
})
