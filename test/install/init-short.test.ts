/**
 * init --kind short 短篇集布局测试 —— M8 #25 第 3/4 节。
 *
 * 验收：短篇集建 篇/ + 共享文风/ + 工作区/；不建 定稿/ 大纲/ 卷纲/ 设定；
 * book.yaml 含 kind: short、无 leads/growth；books.jsonl 登记 kind=short。
 */

import { test, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { doInit } from '../../src/install/init.js'
import { readBooks } from '../../src/install/books.js'
import { readBookConfig } from '../../src/format/yaml.js'

const ORIG_CWD = process.cwd()

beforeEach(() => { process.chdir(ORIG_CWD) })
afterEach(() => { process.chdir(ORIG_CWD) })

test('init short: 建短篇集布局（篇/ + 共享文风 + 工作区），不建长程载重', () => {
  const wd = mkdtempSync(join(tmpdir(), 'init-short-'))
  try {
    const r = doInit({ workDir: wd, name: '夜语集', genre: '悬疑', kind: 'short' })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const bookRoot = r.bookRoot

    // 核心差异：篇/ 存在（空，不预建篇）
    expect(existsSync(join(bookRoot, '篇'))).toBe(true)
    expect(readdirSync(join(bookRoot, '篇'))).toHaveLength(0)

    // 整集共享文风（样章库五场景 + 文风铁律 + 金句库）
    expect(existsSync(join(bookRoot, '文风', '样章库', '战斗'))).toBe(true)
    expect(existsSync(join(bookRoot, '文风', '样章库', '爽点高潮'))).toBe(true)
    expect(existsSync(join(bookRoot, '文风', '文风铁律.md'))).toBe(true)
    expect(existsSync(join(bookRoot, '文风', '金句库'))).toBe(true)

    // 工作区（临时区）
    expect(existsSync(join(bookRoot, '工作区'))).toBe(true)

    // 不建长程载重
    expect(existsSync(join(bookRoot, '定稿'))).toBe(false)
    expect(existsSync(join(bookRoot, '大纲'))).toBe(false)

    // 独立 git + book.yaml + AGENTS.md + .gitignore
    expect(existsSync(join(bookRoot, '.git'))).toBe(true)
    expect(existsSync(join(bookRoot, '.git', 'hooks', 'pre-push'))).toBe(true)
    expect(readFileSync(join(bookRoot, '.git', 'hooks', 'pre-push'), 'utf-8')).toContain('Push is blocked by default')
    expect(existsSync(join(bookRoot, 'book.yaml'))).toBe(true)
    expect(existsSync(join(bookRoot, 'AGENTS.md'))).toBe(true)
    expect(existsSync(join(bookRoot, '.gitignore'))).toBe(true)
  } finally {
    rmSync(wd, { recursive: true, force: true })
  }
})

test('init short: book.yaml 含 kind: short、无 leads/growth 段', () => {
  const wd = mkdtempSync(join(tmpdir(), 'init-short-'))
  try {
    const r = doInit({ workDir: wd, name: '夜语集', genre: '悬疑', kind: 'short' })
    expect(r.ok).toBe(true)
    if (!r.ok) return

    const cfg = readBookConfig(join(r.bookRoot, 'book.yaml')).config
    expect(cfg.kind).toBe('short')

    // 文本里确认无 leads/growth 段
    const text = readFileSync(join(r.bookRoot, 'book.yaml'), 'utf-8')
    expect(text).toMatch(/^kind: short$/m)
    expect(text).not.toContain('leads:')
    expect(text).not.toContain('growth:')
    // 保留 style/budget.calls/auto
    expect(text).toContain('style:')
    expect(text).toContain('calls_per_chapter')
  } finally {
    rmSync(wd, { recursive: true, force: true })
  }
})

test('init short: books.jsonl 登记 kind=short', () => {
  const wd = mkdtempSync(join(tmpdir(), 'init-short-'))
  try {
    const r = doInit({ workDir: wd, name: '夜语集', genre: '悬疑', kind: 'short' })
    expect(r.ok).toBe(true)
    if (!r.ok) return

    const books = readBooks(wd)
    expect(books).toHaveLength(1)
    expect(books[0]!.kind).toBe('short')
    expect(books[0]!.name).toBe('夜语集')
  } finally {
    rmSync(wd, { recursive: true, force: true })
  }
})

test('init short: AGENTS.md 含短篇集语义文案', () => {
  const wd = mkdtempSync(join(tmpdir(), 'init-short-'))
  try {
    const r = doInit({ workDir: wd, name: '夜语集', genre: '悬疑', kind: 'short' })
    expect(r.ok).toBe(true)
    if (!r.ok) return

    const agents = readFileSync(join(r.bookRoot, 'AGENTS.md'), 'utf-8')
    expect(agents).toContain('短篇集')
    expect(agents).toContain('篇/')
  } finally {
    rmSync(wd, { recursive: true, force: true })
  }
})
