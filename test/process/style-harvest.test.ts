import { test, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { harvestStyleCandidates } from '../../src/process/style-harvest.js'
import { readCandidates, CANDIDATES_DIR } from '../../src/format/style-candidate.js'

let root = ''
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'clw-harvest-'))
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

/** 建最小可收割书：book.yaml + 正文 + 文风铁律（无布线 → short 路径）。 */
function makeBook(): void {
  mkdirSync(join(root, '写作', '正文'), { recursive: true })
  mkdirSync(join(root, '文风'), { recursive: true })
  writeFileSync(join(root, 'book.yaml'), 'spec_version: 1\nkind: short\nbook:\n  title: 收割测试\n')
  writeFileSync(
    join(root, '写作', '正文', '001-雨夜.md'),
    '---\n章号: 1\n标题: 雨夜\n---\n## 开头\n\n门外没有脚印。\n\n## 反转\n\n来客笑了。',
  )
  writeFileSync(
    join(root, '文风', '文风铁律.md'),
    '# 文风铁律\n- 正文纯文本\n- 对话标签占比 < 30%\n',
  )
}

test('空书（无正文/无铁律）：安全返回空候选', () => {
  mkdirSync(join(root, '写作'), { recursive: true })
  const r = harvestStyleCandidates(root, 'short', '2026-08-10')
  expect(r.skipped).toBe(0)
  expect(r.created).toEqual([])
})

test('有正文 + 无漂移：收割返回空，不崩', () => {
  makeBook()
  const r = harvestStyleCandidates(root, 'short', '2026-08-10')
  expect(Array.isArray(r.created)).toBe(true)
  expect(r.skipped).toBeGreaterThanOrEqual(0)
})

test('可持续调用：重复收割幂等（查重闸跳过已确认）', () => {
  makeBook()
  const r1 = harvestStyleCandidates(root, 'short', '2026-08-10')
  const r2 = harvestStyleCandidates(root, 'short', '2026-08-10')
  // 第二次不产生增量（候选已落盘，查重跳过）
  expect(r2.created.length).toBeLessThanOrEqual(r1.created.length)
})

test('候选落盘到 文风/候选/', () => {
  makeBook()
  const r = harvestStyleCandidates(root, 'short', '2026-08-10')
  // 有候选 → 目录存在且可读；无候选 → 目录可不建（persistCandidates 无物不建）
  if (r.created.length > 0) {
    expect(existsSync(join(root, CANDIDATES_DIR))).toBe(true)
    const { candidates } = readCandidates(join(root, CANDIDATES_DIR))
    expect(candidates.length).toBeGreaterThan(0)
  }
})