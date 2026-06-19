import { test, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execSync } from 'node:child_process'
import { repairBooks, readBooks, writeBooks, type BookEntry } from '../../src/install/books.js'
import { doInit } from '../../src/install/init.js'

const ORIG_CWD = process.cwd()

beforeEach(() => {
  process.chdir(ORIG_CWD)
})

afterEach(() => {
  process.chdir(ORIG_CWD)
})

function gitInitBook(root: string, name: string): void {
  execSync('git init', { cwd: root, stdio: 'pipe' })
  execSync('git config user.email t@t.com', { cwd: root, stdio: 'pipe' })
  execSync('git config user.name t', { cwd: root, stdio: 'pipe' })
  execSync('git config commit.gpgsign false', { cwd: root, stdio: 'pipe' })
  writeFileSync(join(root, 'book.yaml'), `spec_version: 1\nbook:\n  title: ${name}\n`, 'utf-8')
  execSync('git add -A && git commit -m init', { cwd: root, stdio: 'pipe' })
}

test('repairBooks: books.jsonl 缺失 → 扫描重建登记', () => {
  const wd = mkdtempSync(join(tmpdir(), 'rep-'))
  mkdirSync(join(wd, '.clwriting'), { recursive: true })
  // 手建两本书（不登记到 books.jsonl）
  const bookA = join(wd, '书A')
  const bookB = join(wd, '书B')
  mkdirSync(bookA, { recursive: true })
  mkdirSync(bookB, { recursive: true })
  gitInitBook(bookA, '书A')
  gitInitBook(bookB, '书B')

  // books.jsonl 不存在 → repairBooks 扫描重建
  const result = repairBooks(wd)
  expect(result.changed).toBe(true)
  expect(result.rebuilt).toHaveLength(2)
  const names = result.rebuilt.map((b) => b.name).sort()
  expect(names).toEqual(['书A', '书B'])
  // 重建后 books.jsonl 应存在
  expect(existsSync(join(wd, '.clwriting', 'books.jsonl'))).toBe(true)
  // 再读确认落盘
  expect(readBooks(wd)).toHaveLength(2)

  rmSync(wd, { recursive: true, force: true })
})

test('repairBooks: 已有有效登记无变动 → changed=false', () => {
  const wd = mkdtempSync(join(tmpdir(), 'rep2-'))
  doInit({ workDir: wd, name: '已有书', genre: '玄幻' })
  // init 已登记一本书，repairBooks 应无变动（登记有效）
  const result = repairBooks(wd)
  expect(result.changed).toBe(false)
  expect(result.rebuilt).toHaveLength(1)
  rmSync(wd, { recursive: true, force: true })
})

test('repairBooks: 书目录丢失且无法重关联 → 标 missing 并保留登记', () => {
  const wd = mkdtempSync(join(tmpdir(), 'rep3-'))
  mkdirSync(join(wd, '.clwriting'), { recursive: true })
  // 登记一本指向「书X」的书，但磁盘上没有这个目录
  const fakeEntry: BookEntry = { name: '书X', path: '书X', kind: 'long' }
  writeBooks(wd, [fakeEntry])

  const result = repairBooks(wd)
  expect(result.missing).toHaveLength(1)
  expect(result.missing[0]!.name).toBe('书X')
  expect(result.relinked).toHaveLength(0)
  // missing 登记保留，避免静默丢书；由 CLI 提示作者重关联
  expect(result.rebuilt.find((b) => b.name === '书X')).toBeDefined()
  expect(readBooks(wd).find((b) => b.name === '书X')).toBeDefined()

  rmSync(wd, { recursive: true, force: true })
})

test('writeBooks: books.jsonl 原子写入且不残留临时文件', () => {
  const wd = mkdtempSync(join(tmpdir(), 'rep-atomic-'))
  const entry: BookEntry = { name: '书A', path: '书A', kind: 'long' }

  writeBooks(wd, [entry])

  expect(JSON.parse(readFileSync(join(wd, '.clwriting', 'books.jsonl'), 'utf-8').trim())).toEqual(entry)
  const leftovers = readdirSync(join(wd, '.clwriting')).filter((f) => f.includes('books.jsonl') && f.endsWith('.tmp'))
  expect(leftovers).toEqual([])

  rmSync(wd, { recursive: true, force: true })
})

test('repairBooks: 书目录移动/改名 → 按 book.yaml 书名自动重关联 path', () => {
  const wd = mkdtempSync(join(tmpdir(), 'rep3b-'))
  mkdirSync(join(wd, '.clwriting'), { recursive: true })
  writeBooks(wd, [{ name: '书X', path: '书X', kind: 'long' }])

  const moved = join(wd, '移动后的书X')
  mkdirSync(moved, { recursive: true })
  gitInitBook(moved, '书X')

  const result = repairBooks(wd)
  expect(result.missing).toHaveLength(0)
  expect(result.relinked).toEqual([{ name: '书X', from: '书X', to: '移动后的书X' }])
  expect(readBooks(wd)).toEqual([
    expect.objectContaining({ name: '书X', path: '移动后的书X', kind: 'long' }),
  ])

  rmSync(wd, { recursive: true, force: true })
})

test('repairBooks: book.yaml title 改名但目录未动 → 更新原登记，不重复登记', () => {
  const wd = mkdtempSync(join(tmpdir(), 'rep3c-'))
  mkdirSync(join(wd, '.clwriting'), { recursive: true })
  writeBooks(wd, [{ name: '旧书名', path: '书X', kind: 'long' }])

  const book = join(wd, '书X')
  mkdirSync(book, { recursive: true })
  gitInitBook(book, '新书名')

  const result = repairBooks(wd)
  expect(result.changed).toBe(true)
  expect(result.rebuilt).toHaveLength(1)
  expect(readBooks(wd)).toEqual([
    expect.objectContaining({ name: '新书名', path: '书X', kind: 'long' }),
  ])

  rmSync(wd, { recursive: true, force: true })
})

test('repairBooks: 非书仓库目录不误纳（无 book.yaml/.git）', () => {
  const wd = mkdtempSync(join(tmpdir(), 'rep4-'))
  mkdirSync(join(wd, '.clwriting'), { recursive: true })
  // 普通目录（无 git/book.yaml）不应被当书
  mkdirSync(join(wd, '普通目录'), { recursive: true })
  writeFileSync(join(wd, '普通目录', '笔记.md'), '随便写的', 'utf-8')

  const result = repairBooks(wd)
  expect(result.rebuilt.find((b) => b.name === '普通目录')).toBeUndefined()

  rmSync(wd, { recursive: true, force: true })
})

test('repairBooks: kind 读取（short 书正确识别）', () => {
  const wd = mkdtempSync(join(tmpdir(), 'rep5-'))
  mkdirSync(join(wd, '.clwriting'), { recursive: true })
  const book = join(wd, '短篇集')
  mkdirSync(book, { recursive: true })
  execSync('git init', { cwd: book, stdio: 'pipe' })
  execSync('git config user.email t@t.com', { cwd: book, stdio: 'pipe' })
  execSync('git config user.name t', { cwd: book, stdio: 'pipe' })
  execSync('git config commit.gpgsign false', { cwd: book, stdio: 'pipe' })
  writeFileSync(join(book, 'book.yaml'), 'kind: short\n', 'utf-8')
  execSync('git add -A && git commit -m init', { cwd: book, stdio: 'pipe' })

  const result = repairBooks(wd)
  const entry = result.rebuilt.find((b) => b.name === '短篇集')
  expect(entry).toBeDefined()
  expect(entry!.kind).toBe('short')

  rmSync(wd, { recursive: true, force: true })
})
