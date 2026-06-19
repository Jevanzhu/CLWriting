/**
 * 短篇按篇回滚测试 —— M8 #26。
 *
 * 验收：short revert 用 pc: 前缀定位；人话「回到第 N 篇」；备份 ref 名含「篇」；
 * 丢弃内容进备份 ref 可找回；回退后 篇/ 只剩目标篇及之前。
 */

import { test, expect } from 'vitest'
import { execSync } from 'node:child_process'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { rollbackToChapter } from '../../src/git/rollback.js'
import { writeBookConfig } from '../../src/format/yaml.js'
import { DEFAULT_CONFIG } from '../../src/format/yaml.js'
import type { BookConfig } from '../../src/format/types.js'

const SHORT_CONFIG: BookConfig = { ...DEFAULT_CONFIG, kind: 'short', book: { title: '夜语集', genre: '悬疑' } }

/** 建短篇集 + 定稿 n 篇（每篇一个 pc:NNN commit）。 */
function makeShortBookWithPieces(n: number): string {
  const root = mkdtempSync(join(tmpdir(), '回滚短篇-'))
  execSync('git init', { cwd: root, stdio: 'pipe' })
  execSync('git config user.email t@t.com && git config user.name t && git config commit.gpgsign false', { cwd: root, stdio: 'pipe' })
  writeBookConfig(join(root, 'book.yaml'), SHORT_CONFIG)
  mkdirSync(join(root, '篇'), { recursive: true })
  mkdirSync(join(root, '工作区'), { recursive: true })
  execSync('git add -A && git commit -m init', { cwd: root, stdio: 'pipe' })

  for (let i = 1; i <= n; i++) {
    const dir = join(root, '篇', `${String(i).padStart(3, '0')}-篇${i}`)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, '正文.md'), `---\n章号: ${i}\n标题: 篇${i}\n---\n\n第${i}篇正文。\n`, 'utf-8')
    execSync(`git add -A && git commit -m "pc:${String(i).padStart(3, '0')} 篇${i}"`, { cwd: root, stdio: 'pipe' })
  }
  return root
}

test('short revert: 写到第 5 篇 → 回到第 3 篇，篇/ 只剩 001-003', () => {
  const root = makeShortBookWithPieces(5)
  try {
    const r = rollbackToChapter(root, 3, 'short')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.revertedTo).toBe(3)
    expect(r.discardedChapters).toBe(2) // 第 4、5 篇丢弃
    // 备份 ref 含「篇」
    expect(r.backupRef).toContain('回到篇3')
    // 人话含「篇」
    expect(r.humanMsg).toContain('回到第 3 篇')

    // 篇/ 只剩 001/002/003
    const pieces = readdirSync(join(root, '篇')).filter((f) => !f.startsWith('.'))
    expect(pieces.some((f) => f.startsWith('001'))).toBe(true)
    expect(pieces.some((f) => f.startsWith('003'))).toBe(true)
    expect(pieces.some((f) => f.startsWith('004'))).toBe(false)
    expect(pieces.some((f) => f.startsWith('005'))).toBe(false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('short revert: 丢弃内容进备份 ref 可找回（可逆铁律）', () => {
  const root = makeShortBookWithPieces(3)
  try {
    const r = rollbackToChapter(root, 1, 'short')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    // 备份 ref 存在（git branch）
    const branches = execSync('git branch --list', { cwd: root, encoding: 'utf-8' })
    expect(branches).toContain(r.backupRef)
    // 备份 ref 里有第 3 篇的 commit（pc:003）
    const log = execSync(`git log ${r.backupRef} --oneline`, { cwd: root, encoding: 'utf-8' })
    expect(log).toMatch(/pc:003/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('short revert: 回到不存在的篇 → 人话拒绝（pc: 前缀找不到）', () => {
  const root = makeShortBookWithPieces(2)
  try {
    const r = rollbackToChapter(root, 9, 'short')
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.humanMsg).toContain('第 9 篇')
      expect(r.humanMsg).toContain('pc:009')
    }
    // 定稿区不变（仍有 2 篇）
    const pieces = readdirSync(join(root, '篇')).filter((f) => !f.startsWith('.'))
    expect(pieces).toHaveLength(2)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
