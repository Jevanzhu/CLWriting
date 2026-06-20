/**
 * 回滚「回到第 N 章」+ 兜底闭环测试 —— #16 第 5 节 + #15 第 4 节 + 第 4.3 节。
 *
 * 工单施工序 7-8 验证点：
 * - 回滚后定稿区 / .cache / 工作区三者一致（M3 出口）
 * - 伪造确认 → enter 复述暴露 → revert 推翻（M3 出口三，第 4.3 节兜底闭环）
 */

import { test, expect } from 'vitest'
import { rmSync, writeFileSync, existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { execSync } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import { makeGitBook, makeGitBookWithChapters } from '../helpers/book.js'
import { rollbackToChapter } from '../../src/git/rollback.js'
import { enter, formatRecap } from '../../src/state/state.js'
import { findChapterCommit } from '../../src/git/exec.js'
import { appendMetric, readMetrics, type MetricRecord } from '../../src/metrics/ledger.js'

function sh(cmd: string, cwd: string): string {
  return execSync(cmd, { cwd, encoding: 'utf-8', stdio: 'pipe' })
}

function metricRecord(num: number): MetricRecord {
  return {
    kind: 'long',
    num,
    title: `第${num}章`,
    words: 1000,
    at: `2026-06-20T00:00:0${num}.000Z`,
    calls: { outline: 1, draft: 1, review: 3, total: 5, limit: 8 },
    tokens: null,
    review: null,
  }
}

// ── #16 第 5 节：回滚三者一致 ─────────────────────────

test('回滚: 写到第 5 章 → 回到第 3 章，定稿区只剩 1-3 章', () => {
  const root = makeGitBookWithChapters(5)
  const r = rollbackToChapter(root, 3)

  expect(r.ok).toBe(true)
  if (r.ok) {
    expect(r.revertedTo).toBe(3)
    expect(r.discardedChapters).toBe(2) // 第 4、5 章丢弃
    expect(r.backupRef).toContain('回到章3')
    // 定稿区只剩 0001/0002/0003
    const chapters = readdirSync(join(root, '定稿', '正文')).filter((f) => f.endsWith('.md'))
    expect(chapters.some((f) => f.startsWith('0001'))).toBe(true)
    expect(chapters.some((f) => f.startsWith('0003'))).toBe(true)
    expect(chapters.some((f) => f.startsWith('0004'))).toBe(false)
    expect(chapters.some((f) => f.startsWith('0005'))).toBe(false)
  }
  rmSync(root, { recursive: true, force: true })
})

test('回滚: 三者一致——定稿区 / .cache / HEAD 对齐（M3 出口）', () => {
  const root = makeGitBookWithChapters(5)
  rollbackToChapter(root, 2)

  // 定稿区：2 章
  const chapters = readdirSync(join(root, '定稿', '正文')).filter((f) => f.endsWith('.md'))
  expect(chapters).toHaveLength(2)

  // .cache：重建后 chapters 表也是 2 条
  const db = new DatabaseSync(join(root, '.cache', 'index.db'))
  const row = db.prepare('SELECT count(*) AS c FROM chapters').get() as { c: number }
  db.close()
  expect(row.c).toBe(2)

  // HEAD：最近 commit 是 ch:0002
  const log = sh('git log --oneline -1', root)
  expect(log).toMatch(/ch:0002/)
  rmSync(root, { recursive: true, force: true })
})

test('回滚: 指标账保留到目标章，删除目标章之后的记录', () => {
  const root = makeGitBookWithChapters(5)
  for (let i = 1; i <= 5; i++) appendMetric(root, metricRecord(i))

  const r = rollbackToChapter(root, 3)
  expect(r.ok).toBe(true)
  expect(readMetrics(root).map((m) => m.num)).toEqual([1, 2, 3])

  const db = new DatabaseSync(join(root, '.cache', 'index.db'))
  const row = db.prepare('SELECT count(*) AS c FROM chapters').get() as { c: number }
  db.close()
  expect(row.c).toBe(3)
  rmSync(root, { recursive: true, force: true })
})

test('回滚: 丢弃内容进备份 ref，可找回（可逆铁律）', () => {
  const root = makeGitBookWithChapters(5)
  const r = rollbackToChapter(root, 2)
  expect(r.ok).toBe(true)
  if (r.ok) {
    // 备份 ref 存在
    const branches = sh('git branch --list', root)
    expect(branches).toContain(r.backupRef)
    // 备份 ref 上能看到第 5 章（可找回）
    const backupLog = sh(`git log ${r.backupRef} --oneline`, root)
    expect(backupLog).toMatch(/ch:0005/)
  }
  rmSync(root, { recursive: true, force: true })
})

test('回滚: 回到不存在的章 → 人话拒绝，不动任何东西', () => {
  const root = makeGitBookWithChapters(3)
  const r = rollbackToChapter(root, 99)
  expect(r.ok).toBe(false)
  if (!r.ok) expect(r.humanMsg).toContain('找不到第 99 章')
  // 书状态没变（还是 3 章）
  const chapters = readdirSync(join(root, '定稿', '正文')).filter((f) => f.endsWith('.md'))
  expect(chapters).toHaveLength(3)
  rmSync(root, { recursive: true, force: true })
})

test('回滚: 回退后工作区清空（草稿/细纲/.confirm 没了）', () => {
  const root = makeGitBookWithChapters(4)
  // 工作区塞点未完成内容
  const workDir = join(root, '工作区')
  writeFileSync(join(workDir, '草稿-5.md'), '草稿', 'utf-8')
  writeFileSync(join(workDir, '细纲.md'), '细纲', 'utf-8')
  writeFileSync(join(workDir, '.confirm.json'), '{}', 'utf-8')

  rollbackToChapter(root, 2)

  expect(existsSync(join(workDir, '草稿-5.md'))).toBe(false)
  expect(existsSync(join(workDir, '细纲.md'))).toBe(false)
  expect(existsSync(join(workDir, '.confirm.json'))).toBe(false)
  rmSync(root, { recursive: true, force: true })
})

// ── #15 第 4 节 + 第 4.3 节：兜底闭环（M3 出口三）──────

test('兜底闭环: 伪造确认 → enter 复述暴露 → revert 推翻（M3 出口三）', () => {
  const root = makeGitBookWithChapters(2)
  // 模拟第 2 章「伪造确认」：commit msg 里的确认哈希是假的（与细纲对不上）
  // 第 2 章定稿后，作者偷改了第 2 章细纲（.confirm 哈希失效）
  // 这里直接造一个带 Confirmed trailer 的 commit + 一个不一致的细纲
  const workDir = join(root, '工作区')
  // 伪造：工作区放一个细纲，其哈希与第 2 章 commit trailer 不符
  writeFileSync(join(workDir, '细纲.md'), '这是被偷改的第 2 章细纲（哈希对不上 commit trailer）', 'utf-8')
  // 给第 2 章 commit 加一个 Confirmed trailer（哈希是假的 sha256:fake）
  sh('git commit --amend -m "ch:0002 第2章\n\nConfirmed: 2026-06-17T10:00 mode=auto hash=sha256:fakehash" --no-edit', root)

  // #1 enter 近况复述应暴露：确认哈希不一致
  const { recap } = enter(root)
  expect(recap.lastConfirm).toBeDefined()
  if (recap.lastConfirm) {
    expect(recap.lastConfirm.chapter).toBe(2)
    expect(recap.lastConfirm.mode).toBe('auto') // 自动盖章（伪造的可疑点）
    expect(recap.lastConfirm.verified).toBe(false) // 哈希不符 → 暴露
  }
  const recapText = formatRecap(recap)
  expect(recapText).toContain('不一致')

  // #2 作者察觉，下达「回到第 2 章」推翻
  const r = rollbackToChapter(root, 2)
  expect(r.ok).toBe(true)
  // 推翻成立：回退到第 2 章，伪造的被撤销（偷改的细纲随工作区清理）
  if (r.ok) {
    expect(existsSync(join(workDir, '细纲.md'))).toBe(false)
    expect(r.humanMsg).toContain('已回到第 2 章')
  }
  rmSync(root, { recursive: true, force: true })
})

test('兜底闭环: 正常确认但细纲已清理 → enter 只复述留痕，不误报已复核', () => {
  const root = makeGitBookWithChapters(1)
  // 第 1 章正常定稿后，finalize 会清理工作区细纲；没有细纲就无法重新计算哈希。
  sh('git commit --amend -m "ch:0001 第1章\n\nConfirmed: 2026-06-17T10:00 mode=manual hash=sha256:real" --no-edit', root)
  // 不放工作区细纲 → parseLastConfirm 只复述提交留痕（verified=null），不伪装成一致。

  const { recap } = enter(root)
  if (recap.lastConfirm) {
    expect(recap.lastConfirm.verified).toBeNull()
  }
  const text = formatRecap(recap)
  expect(text).not.toContain('不一致')
  expect(text).toContain('未复核')
  rmSync(root, { recursive: true, force: true })
})
