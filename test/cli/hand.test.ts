/**
 * `clwriting hand` 手写起草 CLI 测试 —— W2B B2.2。
 *
 * 验证：长/短篇草稿模板创建 + 编辑锁占用 + 未完 batch / 非态 7 拒绝。
 */

import { test, expect, vi } from 'vitest'
import { execSync } from 'node:child_process'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeGitBook, stageIncompleteChapter } from '../helpers/book.js'
import { writeBookConfig, DEFAULT_CONFIG } from '../../src/format/yaml.js'
import { writeBatchProgress } from '../../src/auto/batch.js'
import { handCommand } from '../../src/cli/hand.js'
import { guiActivePath } from '../../src/process/gui-active.js'
import type { BookConfig } from '../../src/format/types.js'

const SHORT_CONFIG: BookConfig = { ...DEFAULT_CONFIG, kind: 'short', book: { title: '夜语集', genre: '悬疑' } }

function makeShortBook(): string {
  const root = mkdtempSync(join(tmpdir(), 'cli-hand短-'))
  execSync('git init', { cwd: root, stdio: 'pipe' })
  execSync('git config user.email t@t.com && git config user.name t && git config commit.gpgsign false', { cwd: root, stdio: 'pipe' })
  writeBookConfig(join(root, 'book.yaml'), SHORT_CONFIG)
  mkdirSync(join(root, '篇'), { recursive: true })
  mkdirSync(join(root, '工作区'), { recursive: true })
  execSync('git add -A && git commit -m init', { cwd: root, stdio: 'pipe' })
  return root
}

/** 捕获 console + process.exit（命令处理器内调 process.exit） */
function captureCli(run: () => void): { stdout: string; exitCode: string | null } {
  const out: string[] = []
  let exitCode: string | null = null
  const log = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => out.push(a.map(String).join(' ')))
  const err = vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => out.push(a.map(String).join(' ')))
  const exit = vi.spyOn(process, 'exit').mockImplementation(((code?: string | number | null) => {
    exitCode = String(code ?? '')
    throw new Error(`process.exit ${exitCode}`)
  }) as typeof process.exit)
  try {
    run()
  } catch {
    // process.exit 抛出
  } finally {
    log.mockRestore()
    err.mockRestore()
    exit.mockRestore()
  }
  return { stdout: out.join('\n'), exitCode }
}

test('hand 长篇: 省章号 → 草稿-1.md（nextChapter）+ 占编辑锁 + 文案「第 1 章」', () => {
  const root = makeGitBook()
  const { stdout, exitCode } = captureCli(() => handCommand([root]))
  expect(exitCode).toBeNull()
  const draftPath = join(root, '工作区', '草稿-1.md')
  expect(existsSync(draftPath)).toBe(true)
  expect(readFileSync(draftPath, 'utf-8')).toContain('章号: 1')
  expect(readFileSync(draftPath, 'utf-8')).toContain('标题: 未命名')
  // 编辑锁占用（editing_workdir=true，与 AI 批写互斥）
  const gui = JSON.parse(readFileSync(guiActivePath(root), 'utf-8'))
  expect(gui.editing_workdir).toBe(true)
  expect(stdout).toContain('第 1 章')
  expect(stdout).toContain('定稿')
  rmSync(root, { recursive: true, force: true })
})

test('hand 长篇: 显式章号 3 → 草稿-3.md + 文案「第 3 章」', () => {
  const root = makeGitBook()
  const { stdout, exitCode } = captureCli(() => handCommand(['3', root]))
  expect(exitCode).toBeNull()
  expect(existsSync(join(root, '工作区', '草稿-3.md'))).toBe(true)
  expect(stdout).toContain('第 3 章')
  expect(stdout).toContain('草稿-3.md')
  rmSync(root, { recursive: true, force: true })
})

test('hand 短篇: 省篇号 → 草稿-1.md 用篇号 frontmatter + 文案「第 1 篇」', () => {
  const root = makeShortBook()
  const { stdout, exitCode } = captureCli(() => handCommand([root]))
  expect(exitCode).toBeNull()
  const draftPath = join(root, '工作区', '草稿-1.md')
  expect(existsSync(draftPath)).toBe(true)
  expect(readFileSync(draftPath, 'utf-8')).toContain('篇号: 1')
  expect(stdout).toContain('第 1 篇')
  rmSync(root, { recursive: true, force: true })
})

test('hand: 未完 AI 连写批次 → 拒绝 exit 1（不创建草稿）', () => {
  const root = makeGitBook()
  // 造活跃 batch（无 host_pid → 保守视为活跃，W0-2 §7）
  writeBatchProgress(root, {
    start_chapter: 1,
    target_count: 3,
    next_chapter: 2,
    completed: [1],
    isolated: [],
    paused: null,
    started_at: new Date().toISOString(),
  })
  const { stdout, exitCode } = captureCli(() => handCommand([root]))
  expect(exitCode).toBe('1')
  expect(stdout).toContain('连写批次')
  expect(existsSync(join(root, '工作区', '草稿-1.md'))).toBe(false)
  rmSync(root, { recursive: true, force: true })
})

test('hand: 工作区有未完成章（态 4）→ 拒绝 exit 1', () => {
  const root = makeGitBook()
  stageIncompleteChapter(root, 1) // 造态 4（草稿+细纲+.confirm，未 commit）
  const { stdout, exitCode } = captureCli(() => handCommand([root]))
  expect(exitCode).toBe('1')
  expect(stdout).toContain('态 4')
  rmSync(root, { recursive: true, force: true })
})
