/**
 * R0912-8（2026-09-11 重评-0911c 修复批）：scanCloudCopies 跳过表补工作区内部簿记面。
 *
 * 修复前：跳过表只有 .git/node_modules/.cache/.版本/.trash——工作区/.journal（内含
 * AppleDouble 伴生 `._xxx.jsonl`，恰是同步盘伴生高发位）等内部目录被全树扫到，
 * `._*` 命中 patterns[0] 被当 cloudCopy 报红（进门每次误报幽灵「副本残留」）。
 * 修复后：补 .journal/.snapshots/.账本推进暂存/spills/待定稿/导出（layout.ts
 * WORKSPACE_INTERNAL_DIR_PREFIXES 的目录清单对齐）；跳过判定在 patterns 之前，
 * 内部目录的 `._*` 伴生不再误入候选。顶层/内容区 `._*` 维持既有「报为副本」口径
 *（test/git/exec.test.ts 既有用例锁定，不回归）。
 */
import { test, expect, afterEach } from 'vitest'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { scanCloudCopies } from '../../src/git/exec.js'

const root = join(tmpdir(), 'r0912-cloud-skip-')

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

test('R0912-8: 工作区/.journal 内 AppleDouble 伴生与内容文件不再入候选', () => {
  rmSync(root, { recursive: true, force: true })
  mkdirSync(join(root, '工作区', '.journal'), { recursive: true })
  // .journal 内 `._xxx.jsonl` AppleDouble（修复前的误报源：命中 patterns[0]）
  writeFileSync(join(root, '工作区', '.journal', '._doc_x.jsonl'), 'apple-double', 'utf-8')
  writeFileSync(join(root, '工作区', '.journal', 'doc_x.jsonl'), '{"status":"pending"}', 'utf-8')
  // .journal 内的「名 2.jsonl」同母本形态也不应再被判副本（整目录已跳过）
  writeFileSync(join(root, '工作区', '.journal', 'doc_x 2.jsonl'), 'dup', 'utf-8')
  expect(scanCloudCopies(root)).toEqual([])
})

test('R0912-8: 待定稿/导出/spills/.snapshots/.账本推进暂存 整目录不扫（含副本形态）', () => {
  rmSync(root, { recursive: true, force: true })
  for (const dir of ['待定稿', '导出', 'spills', '.snapshots', '.账本推进暂存']) {
    mkdirSync(join(root, '工作区', dir), { recursive: true })
  }
  // 各内部目录放「副本形态」文件（若被扫到会命中 dedupCopy/zhConflicted）
  writeFileSync(join(root, '工作区', '待定稿', '0001-章.md'), '母本', 'utf-8')
  writeFileSync(join(root, '工作区', '待定稿', '0001-章 2.md'), '副本', 'utf-8')
  writeFileSync(join(root, '工作区', '导出', '全书 2.md'), '副本', 'utf-8')
  writeFileSync(join(root, '工作区', 'spills', '.a.md.1.x.tmp'), 'spill', 'utf-8')
  writeFileSync(join(root, '工作区', '.snapshots', '._old.md'), 'apple-double', 'utf-8')
  writeFileSync(join(root, '工作区', '.账本推进暂存', '._x.md'), 'apple-double', 'utf-8')
  expect(scanCloudCopies(root)).toEqual([])
})

test('R0912-8: 顶层/内容区 `._*` 维持既有「报为副本」口径（不回归）', () => {
  rmSync(root, { recursive: true, force: true })
  mkdirSync(join(root, '写作', '正文'), { recursive: true })
  writeFileSync(join(root, '写作', '正文', '0001-章.md'), '母本', 'utf-8')
  // 顶层 AppleDouble 与 内容区 `名 2.md`（有同名母本）仍照常命中
  writeFileSync(join(root, '._README.md'), 'apple-double', 'utf-8')
  writeFileSync(join(root, '写作', '正文', '0001-章 2.md'), '副本', 'utf-8')
  const copies = scanCloudCopies(root)
  expect(copies).toHaveLength(2)
  expect(copies.some((c) => c.endsWith(join('._README.md')))).toBe(true)
  expect(copies.some((c) => c.endsWith(join('0001-章 2.md')))).toBe(true)
})
