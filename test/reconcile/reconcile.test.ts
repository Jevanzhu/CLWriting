/**
 * 修复确认（#18 第 2 节）+ 未入账手改对账（#18 第 3-4 节）测试。
 *
 * 工单施工序 5 验证点：坏文件/手改 fixture → 走修复确认/补登交互不崩、不误删手改。
 */

import { test, expect } from 'vitest'
import { rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { execSync } from 'node:child_process'
import { makeGitBook } from '../helpers/book.js'
import {
  detectParseErrors, proposeRepair, repairReport, formatRepairReport,
} from '../../src/reconcile/repair.js'
import {
  detectHandEdits, proposeRebook, formatHandEditReport, handeditReport,
} from '../../src/reconcile/handedit.js'

function sh(cmd: string, cwd: string): void {
  execSync(cmd, { cwd, stdio: 'pipe' })
}

// ── #18 第 2 节：源文件修复确认 ───────────────────────

test('修复确认: 坏账本文件 → 检测到 ParseError + 人话定位', () => {
  const root = makeGitBook()
  // 写坏文件（裸文件无 front matter）
  writeFileSync(join(root, '大纲', '伏笔', '伏笔-099-坏.md'), '这是个坏文件没有 front matter', 'utf-8')
  sh('git add -A && git commit -m "加坏文件"', root)

  const errors = detectParseErrors(root)
  expect(errors.length).toBeGreaterThan(0)
  expect(errors.some((e) => e.file.includes('伏笔-099'))).toBe(true)

  const report = repairReport(root)
  expect(report.degraded).toBe(true)
  const text = formatRepairReport(report)
  expect(text).toContain('伏笔-099')
  rmSync(root, { recursive: true, force: true })
})

test('修复确认: 缺必填字段 → obvious 建议给具体改法', () => {
  const root = makeGitBook()
  // 缺「编号」字段
  writeFileSync(join(root, '大纲', '伏笔', '伏笔-098-无编号.md'),
    '---\n标题: 无编号\n类型: 伏笔\n状态: 进行中\n开启章: 1\n---\n\n## 履历\n', 'utf-8')
  sh('git add -A && git commit -m "加缺字段文件"', root)

  const errors = detectParseErrors(root)
  const noIdErr = errors.find((e) => e.message.includes('编号'))
  expect(noIdErr).toBeDefined()
  if (noIdErr) {
    const s = proposeRepair(noIdErr)
    expect(s.kind).toBe('obvious')
    expect(s.proposal).toContain('编号')
  }
  rmSync(root, { recursive: true, force: true })
})

test('修复确认: 坏文件原样保留（修复前不删不覆盖）', () => {
  const root = makeGitBook()
  const badPath = join(root, '大纲', '伏笔', '伏笔-097-坏.md')
  const badContent = '坏内容必须保留'
  writeFileSync(badPath, badContent, 'utf-8')
  sh('git add -A && git commit -m "加坏文件"', root)

  repairReport(root) // 跑修复报告（只检测+建议，不改文件）

  // 坏文件内容原样还在
  expect(existsSync(badPath)).toBe(true)
  expect(readFileSync(badPath, 'utf-8')).toBe(badContent)
  rmSync(root, { recursive: true, force: true })
})

test('修复确认: 干净书 → 无错误、不降级', () => {
  const root = makeGitBook()
  const report = repairReport(root)
  expect(report.errors).toHaveLength(0)
  expect(report.degraded).toBe(false)
  expect(formatRepairReport(report)).toContain('没有坏文件')
  rmSync(root, { recursive: true, force: true })
})

// ── #18 第 3 节：未入账手改提议补登 ───────────────────

test('手改对账: 手改账本履历 → 检测到 + ledger 分类 + 提议同步', () => {
  const root = makeGitBook()
  writeFileSync(join(root, '大纲', '伏笔', '伏笔-031-灭门真凶.md'),
    '---\n编号: 伏笔-031\n标题: 灭门真凶\n类型: 伏笔\n状态: 进行中\n开启章: 1\n---\n\n## 履历\n\n- 第001章 埋下：作者手改证据\n', 'utf-8')

  const report = detectHandEdits(root)
  expect(report.edits.length).toBeGreaterThan(0)
  const ledgerEdit = report.edits.find((e) => e.kind === 'ledger')
  expect(ledgerEdit).toBeDefined()
  if (ledgerEdit) {
    const p = proposeRebook(ledgerEdit)
    expect(p.proposal).toContain('同步进缓存')
  }
  rmSync(root, { recursive: true, force: true })
})

test('手改对账: 手改设定 → 检测到 + 触发影响分析（#17）', () => {
  const root = makeGitBook()
  // 定稿/设定/ 加个设定文件再手改
  sh('mkdir -p 定稿/设定', root)
  writeFileSync(join(root, '定稿', '设定', '林晚.md'), '---\n姓名: 林晚\n境界: 炼气\n---\n主角。\n', 'utf-8')
  sh('git add -A && git commit -m "加设定"', root)
  // 手改设定
  writeFileSync(join(root, '定稿', '设定', '林晚.md'), '---\n姓名: 林晚\n境界: 筑基\n---\n主角。\n', 'utf-8')

  const report = detectHandEdits(root)
  const settingEdit = report.edits.find((e) => e.kind === 'setting')
  expect(settingEdit).toBeDefined()
  if (settingEdit) {
    const p = proposeRebook(settingEdit)
    expect(p.needsImpactAnalysis).toBe(true)
    expect(p.proposal).toContain('影响清单')
  }
  rmSync(root, { recursive: true, force: true })
})

// ── #18 第 4 节：已发布正文手改特殊处理 ───────────────

test('手改对账: 手改已发布正文 → published-text 警示 + 不强制拒（作者有权）', () => {
  const root = makeGitBook()
  // 先定稿一章（产生已发布正文）
  sh('mkdir -p 定稿/正文', root)
  writeFileSync(join(root, '定稿', '正文', '0001-第一章.md'),
    '---\n章号: 1\n标题: 第一章\n钩子类型: 悬念钩\n钩子强弱: 强\n情绪定位: 铺垫\n---\n\n正文内容。\n', 'utf-8')
  sh('git add -A && git commit -m "ch:0001 第一章"', root)
  // 作者手改已发布正文
  writeFileSync(join(root, '定稿', '正文', '0001-第一章.md'),
    '---\n章号: 1\n标题: 第一章\n钩子类型: 悬念钩\n钩子强弱: 强\n情绪定位: 铺垫\n---\n\n作者手改的正文。\n', 'utf-8')

  const report = detectHandEdits(root)
  expect(report.hasPublishedText).toBe(true)
  const pubEdit = report.edits.find((e) => e.isPublished)
  expect(pubEdit).toBeDefined()
  if (pubEdit) {
    const p = proposeRebook(pubEdit)
    // 不强制拒——给三个选项（撤销/回滚/坚持）
    expect(p.proposal).toContain('撤销')
    expect(p.proposal).toContain('回到第')
    expect(p.proposal).toContain('坚持')
  }
  // 坏文件/手改不崩、不误删
  expect(existsSync(join(root, '定稿', '正文', '0001-第一章.md'))).toBe(true)
  rmSync(root, { recursive: true, force: true })
})

test('手改对账: 干净书 → 无手改', () => {
  const root = makeGitBook()
  const { report, proposals } = handeditReport(root)
  expect(report.edits).toHaveLength(0)
  expect(proposals).toHaveLength(0)
  expect(formatHandEditReport(report)).toContain('没有未入账的手改')
  rmSync(root, { recursive: true, force: true })
})
