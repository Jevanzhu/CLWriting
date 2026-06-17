/**
 * 状态机 7 态判定测试 —— #15 第 2 节。
 *
 * 工单施工序 1 验证点：7 种书仓库 fixture（各处一态）→ detectState 正确路由。
 * 每态一个 fixture，验证判定顺序与命中。
 */

import { test, expect } from 'vitest'
import { rmSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { execSync } from 'node:child_process'
import { makeGitBook, makeGitBookWithChapters, stageIncompleteChapter } from '../helpers/book.js'
import { detectState, routeState, enter, formatRecap, formatRoute } from '../../src/state/state.js'
import { DEFAULT_CONFIG } from '../../src/format/yaml.js'
import { writeHealthCheck } from '../../src/cache/healthcheck.js'

function sh(cmd: string, cwd: string): void {
  execSync(cmd, { cwd, stdio: 'pipe' })
}

// ── 态 1: git 健康检查 ──────────────────────────────

test('detectState: git 有问题 → 态 1（体检优先）', () => {
  const root = makeGitBook()
  // 造半提交（staged 残留）
  writeFileSync(join(root, '大纲', '伏笔', '伏笔-031-灭门真凶.md'), '改了', 'utf-8')
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
  writeFileSync(join(root, '大纲', '伏笔', '伏笔-099-坏.md'), '这是个坏文件没有 front matter', 'utf-8')
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
    join(root, '大纲', '伏笔', '伏笔-031-灭门真凶.md'),
    '---\n编号: 伏笔-031\n标题: 灭门真凶\n类型: 伏笔\n状态: 进行中\n开启章: 1\n---\n\n## 履历\n\n- 第001章 埋下：作者手改的证据\n',
    'utf-8',
  )

  const d = detectState(root, DEFAULT_CONFIG)
  expect(d.state).toBe(3)
  if (d.state === 3) {
    expect(d.handEdits.some((f) => f.includes('伏笔-031'))).toBe(true)
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
  const root = makeGitBookWithChapters(50) // 50 章 = 第 1 卷末

  const d = detectState(root, DEFAULT_CONFIG)
  expect(d.state).toBe(5)
  if (d.state === 5) {
    expect(d.volume).toBe(1)
  }
  rmSync(root, { recursive: true, force: true })
})

// ── 态 6: 体检周期（#15 第 6 节，距上次体检 ≥ 阈值则到期）────────

test('detectState: 从未体检且章数够（35 章）→ 态 6 体检周期到期', () => {
  // 35 章：越过态 5（35 % 50 ≠ 0），无 health-check.json → last=0 → 35 ≥ 30 → 态 6
  const root = makeGitBookWithChapters(35)
  const d = detectState(root, DEFAULT_CONFIG)
  expect(d.state).toBe(6)
  if (d.state === 6) {
    expect(d.chaptersSince).toBe(35)
  }
  rmSync(root, { recursive: true, force: true })
})

test('detectState: 近期体检过（距上次 < 阈值）→ 不触发态 6，落态 7', () => {
  const root = makeGitBookWithChapters(35)
  writeHealthCheck(root, 30) // 第 30 章刚体检过 → 距今 5 章 < 30 → 未到期
  const d = detectState(root, DEFAULT_CONFIG)
  expect(d.state).toBe(7)
  if (d.state === 7) {
    expect(d.nextChapter).toBe(36)
  }
  rmSync(root, { recursive: true, force: true })
})

test('detectState: 体检周期阈值边界（距上次恰好 = 阈值 → 到期）', () => {
  const root = makeGitBookWithChapters(40)
  writeHealthCheck(root, 10) // 距今 30 章 = 阈值 → 到期（≥ 判定）
  const d = detectState(root, DEFAULT_CONFIG)
  expect(d.state).toBe(6)
  rmSync(root, { recursive: true, force: true })
})

test('routeState: 态 6 → 体检人话提示（非 AI 桩，建议跑 health）', () => {
  const action = routeState({ state: 6, chaptersSince: 35 })
  expect(action.state).toBe(6)
  expect(action.needsAI).toBe(false)
  expect(action.humanMsg).toContain('体检')
  expect(action.humanMsg).toContain('35')
})

test('体检闭环: 态 6 → 跑 health 干净 → 写 health-check.json → 再 enter 落态 7', () => {
  // 35 章从未体检 → 态 6
  const root = makeGitBookWithChapters(35)
  expect(detectState(root, DEFAULT_CONFIG).state).toBe(6)

  // 模拟作者跑 clwriting health（干净 → 记账）
  // 直接调 writeHealthCheck（healthCommand 干净分支做的事），免引 CLI 进程
  writeHealthCheck(root, 35)

  // 再判态：距上次体检 0 章 < 30 → 落态 7（提示消除）
  const d = detectState(root, DEFAULT_CONFIG)
  expect(d.state).toBe(7)
  if (d.state === 7) {
    expect(d.nextChapter).toBe(36)
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
  const root = makeGitBookWithChapters(3)
  const d = detectState(root, DEFAULT_CONFIG)
  expect(d.state).toBe(7)
  if (d.state === 7) {
    expect(d.nextChapter).toBe(4)
  }
  rmSync(root, { recursive: true, force: true })
})

// ── 判定顺序：体检优先于续跑 ───────────────────────

test('detectState: 体检优先（git 坏 + 工作区未完成 → 先报态 1）', () => {
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

// ── enter 单入口 + 近况复述 ─────────────────────────

test('enter: 干净书 → 近况复述 + 路由建议（零机器味）', () => {
  const root = makeGitBookWithChapters(3)
  const { recap, route } = enter(root)

  // 近况复述
  const recapText = formatRecap(recap)
  expect(recapText).toContain('已定稿到第 3 章')
  expect(recapText).toContain('git 干净')
  // 路由
  const routeText = formatRoute(route)
  expect(routeText).toContain('起草新章')
  expect(routeText).toContain('第 4 章')
  rmSync(root, { recursive: true, force: true })
})

test('enter: 写满一卷 → 近况复述显示态 5 卷末', () => {
  const root = makeGitBookWithChapters(50)
  const { recap, route } = enter(root)
  expect(recap.state).toBe(5)
  expect(formatRoute(route)).toContain('卷复盘')
  rmSync(root, { recursive: true, force: true })
})

// ── 确认复述（#15 第 4 节，兜底闭环前置）────────────

test('enter: 定稿带 Confirmed trailer → 确认复述带哈希', () => {
  const root = makeGitBookWithChapters(1)
  // 手动给最后 commit 加 trailer（模拟 finalize 的 Confirmed 留痕）
  sh('git commit --amend -m "ch:0001 第一章\n\nConfirmed: 2026-06-17T10:00 mode=manual hash=sha256:abc123" --no-edit', root)

  const { recap } = enter(root)
  expect(recap.lastConfirm).toBeDefined()
  if (recap.lastConfirm) {
    expect(recap.lastConfirm.chapter).toBe(1)
    expect(recap.lastConfirm.hash).toBe('sha256:abc123')
    expect(recap.lastConfirm.mode).toBe('manual')
  }
  rmSync(root, { recursive: true, force: true })
})
