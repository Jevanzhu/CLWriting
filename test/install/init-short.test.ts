/**
 * init --kind short 短篇集布局测试 —— M8 #25 第 3/4 节。
 *
 * 验收：短篇集建 写作/正文/ + 大纲/清单/ + 共享文风/ + 工作区/；不建 定稿/ 布线/ 设定/；
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

test('init short: 建短篇集布局（写作/正文/ + 大纲/章纲/ + 共享文风 + 工作区），不建长程载重', () => {
  const wd = mkdtempSync(join(tmpdir(), 'init-short-'))
  try {
    const r = doInit({ workDir: wd, name: '夜语集', genre: '悬疑', kind: 'short' })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const bookRoot = r.bookRoot

    // 核心差异：写作/正文/ 存在（空，不预建篇）
    expect(existsSync(join(bookRoot, '写作', '正文'))).toBe(true)
    expect(readdirSync(join(bookRoot, '写作', '正文'))).toHaveLength(0)

    // 大纲/章纲/（短篇章纲：反转线索表/情绪曲线/伏笔回收）
    expect(existsSync(join(bookRoot, '大纲', '章纲'))).toBe(true)

    // 整集共享文风（条目库 + 文风铁律；样章库/金句库已退场，S8）
    expect(existsSync(join(bookRoot, '文风', '条目', '禁词'))).toBe(true)
    expect(existsSync(join(bookRoot, '文风', '文风铁律.md'))).toBe(true)
    expect(existsSync(join(bookRoot, '文风', '样章库'))).toBe(false)
    expect(existsSync(join(bookRoot, '文风', '金句库'))).toBe(false)

    // 工作区（临时区）
    expect(existsSync(join(bookRoot, '工作区'))).toBe(true)

    // 不建长程载重：无 定稿/、无 布线/、无 设定/（短篇无长程载重）
    expect(existsSync(join(bookRoot, '定稿'))).toBe(false)
    expect(existsSync(join(bookRoot, '布线'))).toBe(false)
    expect(existsSync(join(bookRoot, '设定'))).toBe(false)

    // book.yaml + 初始 manifest（去 git 自管版本系统：不再 git init / 写 gitignore）
    expect(existsSync(join(bookRoot, '.git'))).toBe(false)
    expect(existsSync(join(bookRoot, '.gitignore'))).toBe(false)
    expect(existsSync(join(bookRoot, 'book.yaml'))).toBe(true)
    expect(existsSync(join(bookRoot, '项目', '文档清单.jsonl'))).toBe(true)
    expect(existsSync(join(bookRoot, 'AGENTS.md'))).toBe(false)
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

test('init short: 按题材写入短篇机检推荐阈值', () => {
  const wd = mkdtempSync(join(tmpdir(), 'init-short-calibration-'))
  try {
    const r = doInit({ workDir: wd, name: '夜语集', genre: '悬疑怪谈', kind: 'short' })
    expect(r.ok).toBe(true)
    if (!r.ok) return

    const cfg = readBookConfig(join(r.bookRoot, 'book.yaml')).config
    expect(cfg.short).toEqual({
      profile: '悬疑反转',
      target_emotions: ['惊悚', '后怕', '震惊', '不安'],
      target_reversal_types: ['死者反转', '真凶反转', '身份反转', '时间/记忆反转'],
      target_ending_flavors: ['后怕', '反噬', '余寒', '真相落地'],
      word_min: 6000,
      word_max: 16000,
      body_part_threshold: 5,
      simile_threshold: 8,
      section_count: 5,
      opening_env_chars: 220,
    })

    const text = readFileSync(join(r.bookRoot, 'book.yaml'), 'utf-8')
    expect(text).toContain('short:')
    expect(text).toContain('  profile: 悬疑反转')
    expect(text).toContain('  target_emotions: [惊悚, 后怕, 震惊, 不安]')
    expect(text).toContain('  word_min: 6000')
    expect(text).toContain('  opening_env_chars: 220')
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
    expect(books[0]!.path).toBe('短篇/夜语集')
    expect(existsSync(join(wd, '短篇', '夜语集'))).toBe(true)
  } finally {
    rmSync(wd, { recursive: true, force: true })
  }
})
