/**
 * 短篇按篇定稿测试 —— M8 #26。
 *
 * 验收：short finalize 落 篇/<篇号>-<标题>/正文.md；commit msg pc:<篇号3位>；
 * 跳账本履历、跳章摘要；前置闸只跑审稿裁决 + 确认哈希（跳形式三检）。
 */

import { test, expect } from 'vitest'
import { execSync } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAllTables } from '../../src/cache/schema.js'
import { writeBookConfig } from '../../src/format/yaml.js'
import { DEFAULT_CONFIG } from '../../src/format/yaml.js'
import { doConfirm } from '../../src/gate/confirm.js'
import { doFinalize } from '../../src/finalize/commit.js'
import type { ChapterMeta, BookConfig } from '../../src/format/types.js'

const SHORT_CONFIG: BookConfig = { ...DEFAULT_CONFIG, kind: 'short', book: { title: '夜语集', genre: '悬疑' } }

/** 建一个干净短篇集仓库（git + book.yaml kind:short + 篇/ + 工作区/ + .cache + 初始 commit）。 */
function makeShortBook(): string {
  const root = mkdtempSync(join(tmpdir(), '定稿短篇-'))
  execSync('git init', { cwd: root, stdio: 'pipe' })
  execSync('git config user.email t@t.com && git config user.name t && git config commit.gpgsign false', { cwd: root, stdio: 'pipe' })
  writeBookConfig(join(root, 'book.yaml'), SHORT_CONFIG)
  mkdirSync(join(root, '篇'), { recursive: true })
  mkdirSync(join(root, '文风', '样章库', '战斗'), { recursive: true })
  writeFileSync(join(root, '文风', '文风铁律.md'), '# 文风铁律\n', 'utf-8')
  mkdirSync(join(root, '工作区'), { recursive: true })
  mkdirSync(join(root, '.cache'), { recursive: true })
  // 缓存表建空（短篇形式三检跳过，但 doFinalize 第 5 步 rebuild 会用）
  const db = new DatabaseSync(join(root, '.cache', 'index.db'))
  createAllTables(db)
  db.close()
  execSync('git add -A && git commit -m init', { cwd: root, stdio: 'pipe' })
  return root
}

test('short finalize: 落 篇/<篇号>-<标题>/正文.md + commit pc: 前缀', () => {
  const root = makeShortBook()
  try {
    const db = new DatabaseSync(join(root, '.cache', 'index.db'))
    const workDir = join(root, '工作区')
    const outline = join(workDir, '细纲.md')
    writeFileSync(outline, '雪夜细纲', 'utf-8')
    doConfirm(workDir, 1, outline, 'manual', SHORT_CONFIG) // 确认记录（前置闸哈希）

    const ch: ChapterMeta = { 章号: 1, 标题: '雪夜', 钩子类型: '悬念钩', 钩子强弱: '强', 情绪定位: '转折' }
    const r = doFinalize({
      bookRoot: root, workDir, outlinePath: outline, db, config: SHORT_CONFIG,
      chapter: ch, body: '雪夜的正文内容，主角推开客栈的门……',
      fileName: '001-雪夜/正文.md', hasReviewVerdict: true, kind: 'short',
    })
    expect(r.ok).toBe(true)

    // 落点：篇/001-雪夜/正文.md
    expect(existsSync(join(root, '篇', '001-雪夜', '正文.md'))).toBe(true)
    // 不落 定稿/正文/（短篇无此目录）
    expect(existsSync(join(root, '定稿'))).toBe(false)

    // commit msg：pc:001 雪夜（git log --oneline 带 SHA 前缀，用 contains）
    const log = execSync('git log --oneline', { cwd: root, encoding: 'utf-8' })
    expect(log).toContain('pc:001 雪夜')
    expect(log).not.toMatch(/ch:001/) // 短篇不用 ch: 前缀

    db.close()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('short finalize: 清单.md 随正文同 pc commit 归档', () => {
  const root = makeShortBook()
  try {
    const db = new DatabaseSync(join(root, '.cache', 'index.db'))
    const workDir = join(root, '工作区')
    const outline = join(workDir, '细纲.md')
    writeFileSync(outline, '雪夜细纲', 'utf-8')
    writeFileSync(join(workDir, '清单.md'), '## 反转线索表\n- 核心反转：来客就是死者\n', 'utf-8')
    doConfirm(workDir, 1, outline, 'manual', SHORT_CONFIG)

    const ch: ChapterMeta = { 章号: 1, 标题: '雪夜', 钩子类型: '悬念钩', 钩子强弱: '强', 情绪定位: '转折' }
    const r = doFinalize({
      bookRoot: root, workDir, outlinePath: outline, db, config: SHORT_CONFIG,
      chapter: ch, body: '雪夜的正文内容，主角推开客栈的门……',
      fileName: '001-雪夜/正文.md', hasReviewVerdict: true, kind: 'short',
    })
    expect(r.ok).toBe(true)

    const manifestPath = join(root, '篇', '001-雪夜', '清单.md')
    expect(existsSync(manifestPath)).toBe(true)
    expect(readFileSync(manifestPath, 'utf-8')).toContain('来客就是死者')
    const committedFiles = execSync('git -c core.quotepath=false show --name-only --format= HEAD', { cwd: root, encoding: 'utf-8' })
    expect(committedFiles).toContain('篇/001-雪夜/正文.md')
    expect(committedFiles).toContain('篇/001-雪夜/清单.md')
    db.close()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('short finalize: 跳账本履历 + 跳章摘要（篇/ 下无 大纲/无 定稿/摘要）', () => {
  const root = makeShortBook()
  try {
    const db = new DatabaseSync(join(root, '.cache', 'index.db'))
    const workDir = join(root, '工作区')
    const outline = join(workDir, '细纲.md')
    writeFileSync(outline, '细纲', 'utf-8')
    doConfirm(workDir, 2, outline, 'manual', SHORT_CONFIG)

    const ch: ChapterMeta = { 章号: 2, 标题: '旧伞', 钩子类型: '情绪钩', 钩子强弱: '中', 情绪定位: '转折' }
    // 即便传了 leadUpdates/chapterSummary，短篇分支也应忽略（不写 大纲/不写 摘要）
    const r = doFinalize({
      bookRoot: root, workDir, outlinePath: outline, db, config: SHORT_CONFIG,
      chapter: ch, body: '旧伞正文。',
      fileName: '002-旧伞/正文.md', hasReviewVerdict: true, kind: 'short',
      leadUpdates: [{ leadId: '伏笔-001', entries: [{ 章号: 2, 动词: '埋下', 证据: '伞' }] }],
      chapterSummary: '第2篇摘要',
    })
    expect(r.ok).toBe(true)

    // 无 大纲/ 目录被创建（账本跳过）
    expect(existsSync(join(root, '大纲'))).toBe(false)
    // 无 定稿/摘要（摘要跳过）
    expect(existsSync(join(root, '定稿'))).toBe(false)

    db.close()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('short finalize: 前置闸跳形式三检（无账本也通过），但审稿裁决刚需', () => {
  const root = makeShortBook()
  try {
    const db = new DatabaseSync(join(root, '.cache', 'index.db'))
    const workDir = join(root, '工作区')
    const outline = join(workDir, '细纲.md')
    writeFileSync(outline, '细纲', 'utf-8')
    doConfirm(workDir, 1, outline, 'manual', SHORT_CONFIG)

    const ch: ChapterMeta = { 章号: 1, 标题: '雪夜', 钩子类型: '悬念钩', 钩子强弱: '强', 情绪定位: '转折' }
    // 无审稿裁决 → 拒绝（审稿是刚需闸，长短共用）
    const r = doFinalize({
      bookRoot: root, workDir, outlinePath: outline, db, config: SHORT_CONFIG,
      chapter: ch, body: '正文', fileName: '001-雪夜/正文.md', hasReviewVerdict: false, kind: 'short',
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain('拍板')
    db.close()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('short finalize 成功后工作区清空', () => {
  const root = makeShortBook()
  try {
    const db = new DatabaseSync(join(root, '.cache', 'index.db'))
    const workDir = join(root, '工作区')
    const outline = join(workDir, '细纲.md')
    writeFileSync(outline, '细纲', 'utf-8')
    writeFileSync(join(workDir, '草稿-1.md'), '草稿', 'utf-8')
    writeFileSync(join(workDir, '清单.md'), '清单', 'utf-8')
    mkdirSync(join(workDir, '三审'), { recursive: true })
    writeFileSync(join(workDir, '三审', 'packet.json'), '{}', 'utf-8')
    doConfirm(workDir, 1, outline, 'manual', SHORT_CONFIG)

    const ch: ChapterMeta = { 章号: 1, 标题: '雪夜', 钩子类型: '悬念钩', 钩子强弱: '强', 情绪定位: '转折' }
    const r = doFinalize({
      bookRoot: root, workDir, outlinePath: outline, db, config: SHORT_CONFIG,
      chapter: ch, body: '正文', fileName: '001-雪夜/正文.md', hasReviewVerdict: true, kind: 'short',
    })
    expect(r.ok).toBe(true)

    // 工作区清空（草稿/细纲/清单/三审/.confirm 都没了）
    expect(existsSync(outline)).toBe(false)
    expect(existsSync(join(workDir, '草稿-1.md'))).toBe(false)
    expect(existsSync(join(workDir, '清单.md'))).toBe(false)
    expect(existsSync(join(workDir, '三审'))).toBe(false)
    expect(existsSync(join(workDir, '.confirm.json'))).toBe(false)
    db.close()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
