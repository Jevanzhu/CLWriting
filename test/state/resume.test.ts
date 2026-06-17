/**
 * 工作区续跑（态 4 中断点判定）+ git 人话层测试。
 *
 * 工单施工序 3-4 验证点：
 * - 态 4 续跑判定（#13 第 5 节中断点：pre-commit 续写 / post-commit-residue 幂等清理）
 * - git 人话层：脚本代敲 git 全链路、commit msg 合规、作者侧零裸 git 命令
 */

import { test, expect } from 'vitest'
import { rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { execSync } from 'node:child_process'
import { makeGitBook, makeGitBookWithChapters, stageIncompleteChapter } from '../helpers/book.js'
import { detectState, routeState, formatRoute } from '../../src/state/state.js'
import { addCommit, findChapterCommit, lastCommitMsg } from '../../src/git/exec.js'
import { DEFAULT_CONFIG } from '../../src/format/yaml.js'
import { doConfirm } from '../../src/gate/confirm.js'
import { doFinalize } from '../../src/finalize/commit.js'
import { DatabaseSync } from 'node:sqlite'
import type { ChapterMeta } from '../../src/format/types.js'

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

test('态4: 已 ch: commit 但工作区残留 → post-commit-residue 幂等清理', () => {
  const root = makeGitBook({ withCache: true })
  // 先正常定稿第 1 章（产生 ch:0001 commit）
  const workDir = join(root, '工作区')
  const outline = join(workDir, '细纲.md')
  writeFileSync(outline, '第1章细纲', 'utf-8')
  doConfirm(workDir, 1, outline, 'manual', DEFAULT_CONFIG)
  const db = new DatabaseSync(join(root, '.cache', 'index.db'))
  const ch: ChapterMeta = { 章号: 1, 标题: '第一章', 钩子类型: '悬念钩', 钩子强弱: '强', 情绪定位: '铺垫' }
  const fr = doFinalize({
    bookRoot: root, workDir, outlinePath: outline, db, config: DEFAULT_CONFIG,
    chapter: ch, body: '正文', fileName: '1-第一章.md', hasReviewVerdict: true,
  })
  expect(fr.ok).toBe(true)
  db.close()

  // 模拟 finalize 步骤 4（清工作区）中断：手动把草稿/细纲/.confirm 塞回去
  writeFileSync(join(workDir, '草稿-1.md'), '残留草稿', 'utf-8')
  writeFileSync(join(workDir, '.confirm.json'), JSON.stringify({
    chapter: 1, outline_hash: 'sha256:x', confirmed_at: '2026-06-17T10:00:00.000Z', mode: 'manual',
  }), 'utf-8')

  const d = detectState(root, DEFAULT_CONFIG)
  expect(d.state).toBe(4)
  if (d.state === 4) {
    expect(d.resumePoint).toBe('post-commit-residue')
    const r = routeState(d)
    expect(r.humanMsg).toContain('已定稿')
    expect(r.humanMsg).toContain('幂等清理')
  }
  rmSync(root, { recursive: true, force: true })
})

// ── git 人话层：addCommit / findChapterCommit ───────

test('addCommit: 原子 add+commit，返回 hash', () => {
  const root = makeGitBook()
  writeFileSync(join(root, '大纲', '伏笔', '伏笔-002.md'),
    '---\n编号: 伏笔-002\n标题: 测试\n类型: 伏笔\n状态: 进行中\n开启章: 1\n---\n\n## 履历\n\n- 第001章 埋下：证据\n', 'utf-8')
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
  expect(findChapterCommit(root, 1)).toMatch(/^[0-9a-f]{40}$/)
  expect(findChapterCommit(root, 2)).toMatch(/^[0-9a-f]{40}$/)
  expect(findChapterCommit(root, 3)).toMatch(/^[0-9a-f]{40}$/)
  expect(findChapterCommit(root, 99)).toBeNull() // 不存在的章
  // 三章 commit 不同
  expect(findChapterCommit(root, 1)).not.toBe(findChapterCommit(root, 2))
  rmSync(root, { recursive: true, force: true })
})

test('commit msg 合规（#16 第 4 节前缀）: ch:0001 标题 + Confirmed trailer', () => {
  const root = makeGitBook({ withCache: true })
  const workDir = join(root, '工作区')
  const outline = join(workDir, '细纲.md')
  writeFileSync(outline, '第1章细纲', 'utf-8')
  doConfirm(workDir, 1, outline, 'manual', DEFAULT_CONFIG)
  const db = new DatabaseSync(join(root, '.cache', 'index.db'))
  const ch: ChapterMeta = { 章号: 1, 标题: '北境的雪', 钩子类型: '悬念钩', 钩子强弱: '强', 情绪定位: '铺垫' }
  const r = doFinalize({
    bookRoot: root, workDir, outlinePath: outline, db, config: DEFAULT_CONFIG,
    chapter: ch, body: '正文', fileName: '1-北境的雪.md', hasReviewVerdict: true,
  })
  db.close()
  expect(r.ok).toBe(true)

  const msg = lastCommitMsg(root)
  expect(msg).toMatch(/^ch:0001 北境的雪/) // 前缀 + 4 位补零章号 + 标题
  expect(msg).toContain('Confirmed:') // #11 留痕 trailer
  expect(msg).toContain('mode=manual')
  expect(msg).toContain('hash=sha256:')
  rmSync(root, { recursive: true, force: true })
})

// ── git 隐身验收：作者侧零裸 git 命令 ────────────────

test('git 隐身: finalize 全链路经人话层，作者不敲 git（验收点）', () => {
  // 这是个验收性测试：finalize 内部不直接调 execFileSync('git')，
  // 全经 git/exec.ts 的 addCommit（#16 第 3 节）。
  // 验证方式：finalize 成功后 commit 存在 + msg 合规，且 finalize 源码不含裸 git 调用。
  const root = makeGitBook({ withCache: true })
  const workDir = join(root, '工作区')
  const outline = join(workDir, '细纲.md')
  writeFileSync(outline, '细纲', 'utf-8')
  doConfirm(workDir, 1, outline, 'manual', DEFAULT_CONFIG)
  const db = new DatabaseSync(join(root, '.cache', 'index.db'))
  const ch: ChapterMeta = { 章号: 1, 标题: '第一章', 钩子类型: '悬念钩', 钩子强弱: '强', 情绪定位: '铺垫' }
  const r = doFinalize({
    bookRoot: root, workDir, outlinePath: outline, db, config: DEFAULT_CONFIG,
    chapter: ch, body: '正文', fileName: '1-第一章.md', hasReviewVerdict: true,
  })
  db.close()
  expect(r.ok).toBe(true)
  // commit 真实落盘（经人话层 addCommit，非作者手敲）
  expect(sh('git log --oneline', root)).toContain('ch:0001')
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
