/**
 * 状态机 7 态判定测试 —— #15 第 2 节。
 *
 * 工单施工序 1 验证点：7 种书仓库 fixture（各处一态）→ detectState 正确路由。
 * 每态一个 fixture，验证判定顺序与命中。
 */

import { test, expect } from 'vitest'
import { rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { execSync } from 'node:child_process'
import { makeGitBook, makeGitBookWithChapters, stageIncompleteChapter } from '../helpers/book.js'
import { detectState, routeState, enter } from '../../src/state/state.js'
import { DEFAULT_CONFIG } from '../../src/format/yaml.js'
import { git } from '../../src/git/exec.js'

const FAST_CHAPTER_FIXTURE = { commitEach: false }

function sh(cmd: string, cwd: string): void {
  execSync(cmd, { cwd, stdio: 'pipe' })
}

function mustGit(args: string[], cwd: string): void {
  const r = git(args, cwd)
  if (!r.ok) throw new Error(r.humanMsg)
}

// ── 态 1: git 健康检查 ──────────────────────────────

test('detectState: git 有问题 → 态 1（体检优先）', () => {
  const root = makeGitBook()
  // 造半提交（staged 残留）
  writeFileSync(join(root, '大纲', '悬念', '悬念-031-灭门真凶.md'), '改了', 'utf-8')
  sh('git add -A', root)

  const d = detectState(root, DEFAULT_CONFIG)
  expect(d.state).toBe(1)
  if (d.state === 1) {
    expect(d.issues.length).toBeGreaterThan(0)
    expect(d.issues.some((i) => i.kind === 'halfCommit')).toBe(true)
  }
  rmSync(root, { recursive: true, force: true })
})

// ── 态 2: 源文件解析失败 ────────────────────────────

test('detectState: 源文件解析失败 → 态 2', () => {
  const root = makeGitBook()
  // 写一个坏账本文件（裸文件无 front matter，rebuild 会收 ParseError）
  writeFileSync(join(root, '大纲', '悬念', '悬念-099-坏.md'), '这是个坏文件没有 front matter', 'utf-8')
  sh('git add -A && git commit -m "加坏文件"', root)

  const d = detectState(root, DEFAULT_CONFIG)
  expect(d.state).toBe(2)
  if (d.state === 2) {
    expect(d.parseErrors.length).toBeGreaterThan(0)
  }
  rmSync(root, { recursive: true, force: true })
})

// ── 态 3: 未入账手改 ────────────────────────────────

test('detectState: 定稿区有未 commit 手改 → 态 3', () => {
  const root = makeGitBook()
  // 手改账本正文（保留合法 front matter，只改履历内容——真实手改场景）
  writeFileSync(
    join(root, '大纲', '悬念', '悬念-031-灭门真凶.md'),
    '---\n编号: 悬念-031\n标题: 灭门真凶\n类型: 悬念\n状态: 进行中\n开启章: 1\n---\n\n## 履历\n\n- 第001章 埋下：作者手改的证据\n',
    'utf-8',
  )

  const d = detectState(root, DEFAULT_CONFIG)
  expect(d.state).toBe(3)
  if (d.state === 3) {
    expect(d.handEdits.some((f) => f.includes('悬念-031'))).toBe(true)
  }
  rmSync(root, { recursive: true, force: true })
})

// ── 态 4: 工作区未完成 ──────────────────────────────

test('detectState: 工作区有草稿+确认未定稿 → 态 4', () => {
  const root = makeGitBook()
  stageIncompleteChapter(root, 1) // 写草稿+细纲+.confirm，不 commit

  const d = detectState(root, DEFAULT_CONFIG)
  expect(d.state).toBe(4)
  if (d.state === 4) {
    expect(d.chapterNum).toBe(1)
  }
  rmSync(root, { recursive: true, force: true })
})

// ── 态 5: 卷末 ─────────────────────────────────────

test('detectState: 写满一卷（50 章）→ 态 5 卷末', () => {
  const root = makeGitBookWithChapters(50, FAST_CHAPTER_FIXTURE) // 50 章 = 第 1 卷末

  const d = detectState(root, DEFAULT_CONFIG)
  expect(d.state).toBe(5)
  if (d.state === 5) {
    expect(d.volume).toBe(1)
  }
  rmSync(root, { recursive: true, force: true })
})

test('detectState: book.volume_size 覆盖每卷章数', () => {
  const root = makeGitBookWithChapters(10, FAST_CHAPTER_FIXTURE)
  const config = { ...DEFAULT_CONFIG, book: { ...DEFAULT_CONFIG.book, volume_size: 10 } }

  const d = detectState(root, config)
  expect(d.state).toBe(5)
  if (d.state === 5) {
    expect(d.volume).toBe(1)
  }
  rmSync(root, { recursive: true, force: true })
})

// ── 态 7: 起草新章（兜底）──────────────────────────

test('detectState: 一切干净的空书 → 态 7 起草新章', () => {
  const root = makeGitBook()
  const d = detectState(root, DEFAULT_CONFIG)
  expect(d.state).toBe(7)
  if (d.state === 7) {
    expect(d.nextChapter).toBe(1) // 空书下一章 = 1
  }
  rmSync(root, { recursive: true, force: true })
})

test('detectState: 写了 3 章干净书 → 态 7 下一章 = 4', () => {
  const root = makeGitBookWithChapters(3, FAST_CHAPTER_FIXTURE)
  const d = detectState(root, DEFAULT_CONFIG)
  expect(d.state).toBe(7)
  if (d.state === 7) {
    expect(d.nextChapter).toBe(4)
  }
  rmSync(root, { recursive: true, force: true })
})

// ── 判定顺序：git 异常优先 ────────────────────────

test('detectState: git 异常优先（git 坏 + 工作区未完成 → 先报态 1）', () => {
  const root = makeGitBook()
  stageIncompleteChapter(root, 1) // 工作区未完成（态 4）
  // 再造 git 问题（态 1）
  writeFileSync(join(root, '.git', 'index.lock'), '', 'utf-8')

  const d = detectState(root, DEFAULT_CONFIG)
  expect(d.state).toBe(1) // 态 1 优先于态 4
  rmSync(root, { recursive: true, force: true })
})

// ── 路由（routeState）──────────────────────────────

test('routeState: 各态路由动作 + needsAI 标记', () => {
  // 态 1 不需 AI、态 2/3 需 AI（M3 桩）、态 4/7 不需 AI
  const root1 = makeGitBook()
  writeFileSync(join(root1, '.git', 'index.lock'), '', 'utf-8')
  expect(routeState(detectState(root1, DEFAULT_CONFIG)).action).toBe('git-health')
  rmSync(root1, { recursive: true, force: true })

  const root7 = makeGitBook()
  const r7 = routeState(detectState(root7, DEFAULT_CONFIG))
  expect(r7.action).toBe('write-new-chapter')
  expect(r7.humanMsg).toContain('第 1 章')
  rmSync(root7, { recursive: true, force: true })
})

test('routeState: 态 7 统一写章入口（CLI 退场，不再分手写/严格）', () => {
  // 自由 / 严格 / 缺省 config → 一律 write-new-chapter（写章收敛到全自动/编辑器）
  const rootFree = makeGitBook()
  const freeCfg = { ...DEFAULT_CONFIG, workflow: 'free' as const }
  expect(routeState(detectState(rootFree, freeCfg), 'long').action).toBe('write-new-chapter')
  rmSync(rootFree, { recursive: true, force: true })

  const rootStrict = makeGitBook()
  const strictCfg = { ...DEFAULT_CONFIG, workflow: 'strict' as const }
  expect(routeState(detectState(rootStrict, strictCfg), 'long').action).toBe('write-new-chapter')
  rmSync(rootStrict, { recursive: true, force: true })

  // 无 config（旧调用兼容）→ AI 流程
  const root7 = makeGitBook()
  expect(routeState(detectState(root7, DEFAULT_CONFIG), 'long').action).toBe('write-new-chapter')
  rmSync(root7, { recursive: true, force: true })
})

// ── enter 单入口 + 近况复述 ─────────────────────────

test('enter: 干净书 → recap + route 结构正确', () => {
  const root = makeGitBookWithChapters(3, FAST_CHAPTER_FIXTURE)
  const { recap, route } = enter(root)

  expect(recap.currentChapter).toBe(3)
  expect(recap.gitClean).toBe(true)
  expect(recap.nextChapter).toBe(4)
  expect(route.action).toBe('write-new-chapter')
  rmSync(root, { recursive: true, force: true })
})

test('enter: git 异常且缓存缺失 → 不崩，返回 git-health 路由', () => {
  const root = makeGitBook()
  writeFileSync(join(root, '.git', 'index.lock'), '', 'utf-8')

  const result = enter(root)
  expect(result.recap.state).toBe(1)
  expect(result.recap.currentChapter).toBe(0)
  expect(result.route.action).toBe('git-health')
  rmSync(root, { recursive: true, force: true })
})

test('enter: 写满一卷 → recap 显示态 5 卷末', () => {
  const root = makeGitBookWithChapters(50, FAST_CHAPTER_FIXTURE)
  const { recap, route } = enter(root)
  expect(recap.state).toBe(5)
  expect(route.action).toBe('volume-review')
  rmSync(root, { recursive: true, force: true })
})

// ── 确认复述（#15 第 4 节，兜底闭环前置）────────────

test('enter: 定稿带 Confirmed trailer → 确认复述带哈希', () => {
  const root = makeGitBookWithChapters(1)
  // 手动给最后 commit 加 trailer（模拟 finalize 的 Confirmed 留痕）
  mustGit([
    'commit',
    '--amend',
    '-m',
    'ch:0001 第一章\n\nConfirmed: 2026-06-17T10:00 mode=manual hash=sha256:abc123',
    '--no-edit',
  ], root)

  const { recap } = enter(root)
  expect(recap.lastConfirm).toBeDefined()
  if (recap.lastConfirm) {
    expect(recap.lastConfirm.chapter).toBe(1)
    expect(recap.lastConfirm.hash).toBe('sha256:abc123')
    expect(recap.lastConfirm.mode).toBe('manual')
  }
  rmSync(root, { recursive: true, force: true })
})
