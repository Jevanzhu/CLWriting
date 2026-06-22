/**
 * 短篇精简态机测试 —— M8 #25/#26。
 *
 * 验收：短篇（kind:short）走精简态机（态 1-4 + 7），有待定稿篇时进态 8，不判态 5/6；
 * 态 3 手改看 篇/；态 4 续跑用 pc: 前缀；态 7 篇号 = 扫 篇/ 子目录数 + 1。
 */

import { test, expect } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execSync } from 'node:child_process'
import { detectState, enter } from '../../src/state/state.js'
import { writeBookConfig, DEFAULT_CONFIG } from '../../src/format/yaml.js'
import type { BookConfig } from '../../src/format/types.js'

const SHORT_CONFIG: BookConfig = { ...DEFAULT_CONFIG, kind: 'short', book: { title: '夜语集', genre: '悬疑' } }

/** 建一个干净短篇集仓库（git + book.yaml kind:short + 篇/ + 文风/ + 工作区/ + 初始 commit）。 */
function makeShortBook(): string {
  const root = mkdtempSync(join(tmpdir(), '夜语集-'))
  execSync('git init', { cwd: root, stdio: 'pipe' })
  execSync('git config user.email t@t.com && git config user.name t && git config commit.gpgsign false', { cwd: root, stdio: 'pipe' })
  writeBookConfig(join(root, 'book.yaml'), SHORT_CONFIG)
  mkdirSync(join(root, '篇'), { recursive: true })
  for (const s of ['战斗', '对话', '抒情', '叙事铺陈', '爽点高潮']) {
    mkdirSync(join(root, '文风', '样章库', s), { recursive: true })
  }
  mkdirSync(join(root, '文风', '金句库'), { recursive: true })
  writeFileSync(join(root, '文风', '文风铁律.md'), '# 文风铁律\n', 'utf-8')
  mkdirSync(join(root, '工作区'), { recursive: true })
  execSync('git add -A && git commit -m init', { cwd: root, stdio: 'pipe' })
  return root
}

/** 造一篇定稿（篇/<篇号3位>-<标题>/正文.md + pc: commit）。 */
function finalizePiece(root: string, num: number, title: string): void {
  const dir = join(root, '篇', `${String(num).padStart(3, '0')}-${title}`)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, '正文.md'), `---\n章号: ${num}\n标题: ${title}\n---\n\n第${num}篇正文。\n`, 'utf-8')
  execSync(`git add -A && git commit -m "pc:${String(num).padStart(3, '0')} ${title}"`, { cwd: root, stdio: 'pipe' })
}

test('short 态 3: 篇/ 有未 commit 改动 → 态 3（看 篇/，不看 定稿//大纲/）', () => {
  const root = makeShortBook()
  try {
    // 改已定稿篇的正文（未 commit）→ 态 3 手改
    finalizePiece(root, 1, '雪夜')
    writeFileSync(join(root, '篇', '001-雪夜', '正文.md'), '---\n章号: 1\n标题: 雪夜\n---\n\n改过的正文。\n', 'utf-8')

    const d = detectState(root, SHORT_CONFIG)
    expect(d.state).toBe(3)
    if (d.state === 3) {
      expect(d.handEdits.some((p) => p.startsWith('篇/'))).toBe(true)
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('short 态 4: 工作区有半截篇（草稿+.confirm）但无对应 pc: commit → 态 4 pre-commit', () => {
  const root = makeShortBook()
  try {
    const workDir = join(root, '工作区')
    writeFileSync(join(workDir, '细纲.md'), '第2篇细纲', 'utf-8')
    writeFileSync(join(workDir, '草稿-2.md'), '第2篇草稿', 'utf-8')
    writeFileSync(join(workDir, '.confirm.json'), JSON.stringify({ chapter: 2, outline_hash: 'sha256:x', confirmed_at: '2026-06-19T00:00:00Z', mode: 'manual' }), 'utf-8')

    const d = detectState(root, SHORT_CONFIG)
    expect(d.state).toBe(4)
    if (d.state === 4) {
      expect(d.chapterNum).toBe(2)
      expect(d.resumePoint).toBe('pre-commit') // 无 pc:002 commit
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('short 态 4: 工作区半截篇 + 已有 pc: commit → 态 4 post-commit-residue', () => {
  const root = makeShortBook()
  try {
    finalizePiece(root, 2, '旧伞') // 第 2 篇已定稿（pc:002 存在）
    // 工作区残留第 2 篇的草稿/.confirm（post-commit residue）
    const workDir = join(root, '工作区')
    writeFileSync(join(workDir, '细纲.md'), '第2篇细纲', 'utf-8')
    writeFileSync(join(workDir, '.confirm.json'), JSON.stringify({ chapter: 2, outline_hash: 'sha256:x', confirmed_at: '2026-06-19T00:00:00Z', mode: 'manual' }), 'utf-8')

    const d = detectState(root, SHORT_CONFIG)
    expect(d.state).toBe(4)
    if (d.state === 4) {
      expect(d.chapterNum).toBe(2)
      expect(d.resumePoint).toBe('post-commit-residue') // pc:002 已存在
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('short 态 7: 空短篇集（无篇）→ 起草第 1 篇（篇号 = 0 + 1）', () => {
  const root = makeShortBook()
  try {
    const d = detectState(root, SHORT_CONFIG)
    expect(d.state).toBe(7)
    if (d.state === 7) {
      expect(d.nextChapter).toBe(1) // 篇/ 空 → 第 1 篇
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('short 态 7: 已有 2 篇定稿 → 起草第 3 篇（篇号 = 扫 篇/ 数 + 1）', () => {
  const root = makeShortBook()
  try {
    finalizePiece(root, 1, '雪夜')
    finalizePiece(root, 2, '旧伞')

    const d = detectState(root, SHORT_CONFIG)
    expect(d.state).toBe(7)
    if (d.state === 7) {
      expect(d.nextChapter).toBe(3) // 篇/ 有 2 篇 → 第 3 篇
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('short 不触发态 5/6: 已有多篇也不判卷末/体检（无长程概念）', () => {
  const root = makeShortBook()
  try {
    // 造 3 篇（足够验证不误判；态 5 要 50 章、态 6 要 30 章，短篇即使凑数也不触发）
    for (let i = 1; i <= 3; i++) finalizePiece(root, i, `篇${i}`)
    const d = detectState(root, SHORT_CONFIG)
    expect(d.state).toBe(7) // 直接落态 7，不进 5/6
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('short 态 8: 待定稿有完成篇 → detectState 返回态 8', () => {
  const root = makeShortBook()
  try {
    const pendingDir = join(root, '工作区', '待定稿', '001-雪夜')
    mkdirSync(pendingDir, { recursive: true })
    writeFileSync(join(pendingDir, '草稿-1.md'), '---\n篇号: 1\n标题: 雪夜\n---\n正文。\n', 'utf-8')
    writeFileSync(join(pendingDir, '细纲.md'), '雪夜细纲', 'utf-8')

    const d = detectState(root, SHORT_CONFIG)
    expect(d.state).toBe(8)
    if (d.state === 8) {
      expect(d.pendingChapters).toEqual([1])
    }
    const result = enter(root)
    expect(result.route.state).toBe(8)
    expect(result.route.humanMsg).toContain('1 篇待审稿')
    expect(result.route.humanMsg).toContain('第 1 篇')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('long 回归: 同一 detectState 长篇分支不受 short 改动影响', () => {
  const root = mkdtempSync(join(tmpdir(), '长篇-'))
  try {
    execSync('git init', { cwd: root, stdio: 'pipe' })
    execSync('git config user.email t@t.com && git config user.name t && git config commit.gpgsign false', { cwd: root, stdio: 'pipe' })
    writeBookConfig(join(root, 'book.yaml'), DEFAULT_CONFIG) // 无 kind = long
    mkdirSync(join(root, '定稿', '正文'), { recursive: true })
    mkdirSync(join(root, '大纲', '伏笔'), { recursive: true })
    mkdirSync(join(root, '工作区'), { recursive: true })
    mkdirSync(join(root, '.cache'), { recursive: true })
    execSync('git add -A && git commit -m init', { cwd: root, stdio: 'pipe' })

    // 长篇空书 → 态 7（走长篇分支，不进 short 的 countPieces）
    const d = detectState(root, DEFAULT_CONFIG)
    expect(d.state).toBe(7)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
