/**
 * 批 3 机检接线集成测试：
 * - W-P1-3 两端闭合：declaredLeadIds / actualLeadIds 有数据时红项真正触发
 *   （此前生产链路两侧恒空 → 恒绿，见评审 W-P1-3）
 * - W-P2-11 word-count：checkWithDb 从章纲 字数目标 接线 targetWords，
 *   有目标 → 黄项触发；无目标 → 不检也不提示（决策 3）
 */
import { test, expect } from 'vitest'
import { rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runCheckForDocument } from '../../src/check/run.js'
import { getRedItems } from '../../src/check/runner.js'
import { mkdtempTracked } from '../helpers/temp-dir.js'

/** 造一本有布线的完整书：布线/悬念 + 正文一章 + 章纲（带字数目标） */
function makeWiringBook(章纲目标?: number): string {
  const root = mkdtempTracked(join(tmpdir(), 'two-end-'))
  mkdirSync(join(root, '布线', '悬念'), { recursive: true })
  mkdirSync(join(root, '写作', '正文'), { recursive: true })
  mkdirSync(join(root, '大纲', '章纲'), { recursive: true })
  mkdirSync(join(root, '工作区'), { recursive: true })
  mkdirSync(join(root, '项目'), { recursive: true })
  writeFileSync(
    join(root, 'book.yaml'),
    'spec_version: 1\nkind: long\nbook:\n  title: 测试书\nhost: cc\nleads:\n  enabled: []\n',
    'utf-8',
  )
  // 悬念-001 进行中
  writeFileSync(
    join(root, '布线', '悬念', '悬念-001-灭门真凶.md'),
    '---\n编号: 悬念-001\n标题: 灭门真凶\n类型: 悬念\n状态: 进行中\n开启章: 1\n---\n\n## 履历\n',
    'utf-8',
  )
  // 正文一章
  writeFileSync(
    join(root, '写作', '正文', '001-夜访.md'),
    '---\n章号: 1\n标题: 夜访\n钩子类型: 悬念钩\n钩子强弱: 中\n情绪定位: 铺垫\n---\n\n山门外的钟声在雨夜里连响了三下。\n',
    'utf-8',
  )
  // 章纲（带 字数目标）
  const fm = 章纲目标 !== undefined ? '---\n章号: 1\n标题: 夜访\n字数目标: ' + 章纲目标 + '\n---\n\n## 反转线索表\n' : '---\n章号: 1\n标题: 夜访\n---\n\n## 反转线索表\n'
  writeFileSync(join(root, '大纲', '章纲', '001-夜访.md'), fm + '- 核心反转：x\n', 'utf-8')
  return root
}

test('两端闭合：细纲声明推进但未写入履历 → lead-declared-not-done 红', () => {
  const root = makeWiringBook()
  try {
    // 细纲声明 悬念-001（带章号 1），但 账本推进.md 无实际写入
    writeFileSync(join(root, '工作区', '细纲.md'), '---\n章号: 1\n推进: [悬念-001]\n---\n\n本章细纲。\n', 'utf-8')
    const outcome = runCheckForDocument(root, join(root, '写作', '正文', '001-夜访.md'))
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    const reds = getRedItems(outcome.report)
    expect(reds.some((i) => i.checkId === 'lead-declared-not-done')).toBe(true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('两端闭合：实际写入但细纲未声明 → lead-done-not-declared 红', () => {
  const root = makeWiringBook()
  try {
    // 账本推进.md 声明 悬念-001 且证据命中正文（钟声），细纲无推进
    writeFileSync(join(root, '工作区', '账本推进.md'), '- 悬念-001 递进：山门外的钟声在雨夜里连响了三下。\n', 'utf-8')
    writeFileSync(join(root, '工作区', '细纲.md'), '---\n章号: 1\n推进: []\n---\n\n本章细纲。\n', 'utf-8')
    const outcome = runCheckForDocument(root, join(root, '写作', '正文', '001-夜访.md'))
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    const reds = getRedItems(outcome.report)
    expect(reds.some((i) => i.checkId === 'lead-done-not-declared')).toBe(true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('两端闭合：声明并兑现 → 无两端闭合红项', () => {
  const root = makeWiringBook()
  try {
    writeFileSync(join(root, '工作区', '细纲.md'), '---\n章号: 1\n推进: [悬念-001]\n---\n\n本章细纲。\n', 'utf-8')
    writeFileSync(join(root, '工作区', '账本推进.md'), '- 悬念-001 递进：山门外的钟声在雨夜里连响了三下。\n', 'utf-8')
    const outcome = runCheckForDocument(root, join(root, '写作', '正文', '001-夜访.md'))
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    const reds = getRedItems(outcome.report)
    expect(reds.some((i) => i.checkId === 'lead-declared-not-done')).toBe(false)
    expect(reds.some((i) => i.checkId === 'lead-done-not-declared')).toBe(false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('W-P2-11：章纲设 字数目标 且正文大幅偏离 → word-count 黄项', () => {
  const root = makeWiringBook(100)
  try {
    // 正文 ~20 字 vs 目标 100 → 偏差 80% > 30% → 黄
    const outcome = runCheckForDocument(root, join(root, '写作', '正文', '001-夜访.md'))
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    const wc = outcome.report.sections.find((s) => s.name === '字数')
    expect(wc?.items.some((i) => i.checkId === 'word-count')).toBe(true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('W-P2-11：章纲无 字数目标 → 不检也不提示（决策 3）', () => {
  const root = makeWiringBook()
  try {
    const outcome = runCheckForDocument(root, join(root, '写作', '正文', '001-夜访.md'))
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    const wc = outcome.report.sections.find((s) => s.name === '字数')
    expect(wc?.items.some((i) => i.checkId === 'word-count')).toBe(false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('R65-24（批 B）：批量连写归档章——主文件属他章时，本章推进从 .账本推进暂存 认到，不误报红', () => {
  const root = makeWiringBook()
  try {
    // 细纲声明 悬念-001
    writeFileSync(join(root, '工作区', '细纲.md'), '---\n章号: 1\n推进: [悬念-001]\n---\n\n本章细纲。\n', 'utf-8')
    // 主文件带 第2章 标签且载有他章内容（批量连写常态：第 1 章定稿后归档、第 2 章在写）
    writeFileSync(join(root, '工作区', '账本推进.md'), '# 第2章\n- 悬念-002 递进：他章的推进内容。\n', 'utf-8')
    // 本章推进已归档：.账本推进暂存/第1章.md（证据命中正文「钟声」句）
    mkdirSync(join(root, '工作区', '.账本推进暂存'), { recursive: true })
    writeFileSync(join(root, '工作区', '.账本推进暂存', '第1章.md'), '- 悬念-001 递进：山门外的钟声在雨夜里连响了三下。\n', 'utf-8')

    const outcome = runCheckForDocument(root, join(root, '写作', '正文', '001-夜访.md'))
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    const reds = getRedItems(outcome.report)
    // 修复前 actual 侧只读主文件（他章标签 → 本章实际为空）→ lead-declared-not-done 红误报
    expect(reds.some((i) => i.checkId === 'lead-declared-not-done')).toBe(false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
