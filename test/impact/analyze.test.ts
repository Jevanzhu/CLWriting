/**
 * 影响分析测试 —— #17 第 3-4 节。
 *
 * 工单施工序 6 验证点：改已发布章引用的设定 → 产「已发布 N 处 / 未发布 M 处」清单 + 吃书检测。
 */

import { test, expect } from 'vitest'
import { rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { execSync } from 'node:child_process'
import { makeGitBook } from '../helpers/book.js'
import { scanReferences, formatImpactReport } from '../../src/impact/analyze.js'

function sh(cmd: string, cwd: string): void {
  execSync(cmd, { cwd, stdio: 'pipe' })
}

/** 造一本有「已发布章引用设定」+「大纲引用设定」的书 */
function makeBookWithReferences(): string {
  const root = makeGitBook()

  // 已发布正文（定稿/正文/）—— 2 章都引用「筑基」，一次性 commit
  mkdirSync(join(root, '定稿', '正文'), { recursive: true })
  writeFileSync(join(root, '定稿', '正文', '0001-第一章.md'),
    '---\n章号: 1\n标题: 第一章\n钩子类型: 悬念钩\n钩子强弱: 强\n情绪定位: 铺垫\n---\n\n林晚境界：筑基，踏入北境。\n', 'utf-8')
  writeFileSync(join(root, '定稿', '正文', '0050-卷末.md'),
    '---\n章号: 50\n标题: 卷末\n钩子类型: 悬念钩\n钩子强弱: 强\n情绪定位: 转折\n---\n\n他仍是筑基，未进一步。\n', 'utf-8')
  sh('git add -A && git commit -m "ch:0001 第一章"', root)

  // 未发布大纲 —— 引用「筑基」（不 commit，保持「未发布」状态）
  writeFileSync(join(root, '大纲', '伏笔', '伏笔-050-境界线.md'),
    '---\n编号: 伏笔-050\n标题: 境界线\n类型: 伏笔\n状态: 进行中\n开启章: 1\n---\n\n## 履历\n\n- 第001章 埋下：筑基起步\n', 'utf-8')

  return root
}

test('影响分析: 改设定「筑基」→ 已发布/未发布两份清单分桶', () => {
  const root = makeBookWithReferences()
  const report = scanReferences(root, '筑基')

  // 已发布：2 章（第1章、第50章）都引用了筑基
  expect(report.published.length).toBe(2)
  expect(report.published.some((r) => r.file.includes('0001-第一章'))).toBe(true)
  expect(report.published.some((r) => r.file.includes('0050-卷末'))).toBe(true)

  // 未发布：大纲的境界线账本引用了筑基
  expect(report.unpublished.length).toBeGreaterThanOrEqual(1)
  expect(report.unpublished.some((r) => r.file.includes('伏笔-050'))).toBe(true)

  const text = formatImpactReport(report)
  expect(text).toContain('已发布影响')
  expect(text).toContain('未发布影响')
  rmSync(root, { recursive: true, force: true })
})

test('影响分析: 新值与旧值冲突 → 吃书检测（#17 第 4 节）', () => {
  const root = makeBookWithReferences()
  // 设定「筑基」要改成「金丹」，与已发布章的「筑基」直接冲突
  const report = scanReferences(root, '筑基', '金丹')

  expect(report.conflicts.length).toBeGreaterThan(0)
  const c = report.conflicts[0]!
  expect(c.oldValue).toBe('筑基') // 引用行里 target 后跟的旧值
  expect(c.newValue).toBe('金丹')
  expect(c.humanMsg).toContain('吃书')

  const text = formatImpactReport(report)
  expect(text).toContain('吃书预警')
  rmSync(root, { recursive: true, force: true })
})

test('影响分析: 改新值与旧值一致 → 无吃书冲突', () => {
  const root = makeBookWithReferences()
  // 设定「筑基」保持「筑基」，无冲突
  const report = scanReferences(root, '筑基', '筑基')
  expect(report.conflicts).toHaveLength(0)
  rmSync(root, { recursive: true, force: true })
})

test('影响分析: 不存在的设定 → 两份清单都空', () => {
  const root = makeBookWithReferences()
  const report = scanReferences(root, '不存在的设定XYZ')
  expect(report.published).toHaveLength(0)
  expect(report.unpublished).toHaveLength(0)
  rmSync(root, { recursive: true, force: true })
})

test('影响分析: 人话清单含决策归作者（#17 第 1 节原则 7）', () => {
  const root = makeBookWithReferences()
  const report = scanReferences(root, '筑基')
  const text = formatImpactReport(report)
  expect(text).toContain('决策归你')
  expect(text).toContain('顺势圆')
  rmSync(root, { recursive: true, force: true })
})
