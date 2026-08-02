/**
 * 工作区续跑（态 4 中断点判定）+ git 人话层测试。
 *
 * 工单施工序 3-4 验证点：
 * - 态 4 续跑判定（#13 第 5 节中断点：pre-commit 续写 / post-commit-residue 幂等清理）
 * - git 人话层：脚本代敲 git 全链路、作者侧零裸 git 命令
 */

import { test, expect } from 'vitest'
import { rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { execSync } from 'node:child_process'
import { makeGitBook, makeGitBookWithChapters, stageIncompleteChapter } from '../helpers/book.js'
import { detectState, routeState, formatRoute } from '../../src/state/state.js'
import { addCommit, findChapterCommit } from '../../src/git/exec.js'
import { DEFAULT_CONFIG } from '../../src/format/yaml.js'

function sh(cmd: string, cwd: string): string {
  return execSync(cmd, { cwd, encoding: 'utf-8', stdio: 'pipe' })
}

// ── 态 4 续跑：中断点判定（#13 第 5 节）──────────────

test('态4: 草稿+确认无 commit → pre-commit 续写', () => {
  const root = makeGitBook()
  stageIncompleteChapter(root, 1) // 草稿+细纲+.confirm，无 ch:0001 commit

  const d = detectState(root, DEFAULT_CONFIG)
  expect(d.state).toBe(4)
  if (d.state === 4) {
    expect(d.resumePoint).toBe('pre-commit')
    const r = routeState(d)
    expect(r.humanMsg).toContain('接着干')
    expect(r.humanMsg).toContain('续写')
  }
  rmSync(root, { recursive: true, force: true })
})

// ── git 人话层：addCommit / findChapterCommit ───────

test('addCommit: 原子 add+commit，返回 hash', () => {
  const root = makeGitBook()
  writeFileSync(join(root, '大纲', '悬念', '悬念-002.md'),
    '---\n编号: 悬念-002\n标题: 测试\n类型: 悬念\n状态: 进行中\n开启章: 1\n---\n\n## 履历\n\n- 第001章 埋下：证据\n', 'utf-8')
  const r = addCommit(root, 'fix:0001 测试提交')
  expect(r.ok).toBe(true)
  if (r.ok) expect(r.hash).toMatch(/^[0-9a-f]{7,40}$/)
  // 确认真的 commit 了
  expect(sh('git log --oneline', root)).toContain('测试提交')
  rmSync(root, { recursive: true, force: true })
})

test('addCommit: 无改动 → 失败出人话（不抛）', () => {
  const root = makeGitBook()
  const r = addCommit(root, 'ch:0001 空')
  expect(r.ok).toBe(false)
  if (!r.ok) expect(r.humanMsg.length).toBeGreaterThan(0)
  rmSync(root, { recursive: true, force: true })
})

test('findChapterCommit: 按 ch:NNNN 前缀反查章 commit（#16 第 5 节回滚定位）', () => {
  const root = makeGitBookWithChapters(3)
  expect(findChapterCommit(root, 1)).toMatch(/^[0-9a-f]{7,40}$/)
  expect(findChapterCommit(root, 2)).toMatch(/^[0-9a-f]{7,40}$/)
  expect(findChapterCommit(root, 3)).toMatch(/^[0-9a-f]{7,40}$/)
  expect(findChapterCommit(root, 99)).toBeNull() // 不存在的章
  // 三章 commit 不同
  expect(findChapterCommit(root, 1)).not.toBe(findChapterCommit(root, 2))
  rmSync(root, { recursive: true, force: true })
})

// ── 近况复述：续跑态显示中断点 ─────────────────────

test('近况复述: 态4 pre-commit → 路由人话含续写指引', () => {
  const root = makeGitBook()
  stageIncompleteChapter(root, 1)
  const d = detectState(root, DEFAULT_CONFIG)
  const text = formatRoute(routeState(d))
  expect(text).toContain('工作区未完成')
  expect(text).toMatch(/续写|接着干/)
  rmSync(root, { recursive: true, force: true })
})
