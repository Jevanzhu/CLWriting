import { test, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { mkdtempTracked } from '../helpers/temp-dir.js'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execSync } from 'node:child_process'
import {
  readBooks,
  appendBook,
  readActive,
  writeActive,
  findWorkDir,
  isBookRepo,
  type BookEntry,
} from '../../src/install/books.js'

// 用例间 chdir 复位：临时目录清理（rmSync）前先离开，避免 cwd 悬空
const ORIG_CWD = process.cwd()

// 套件级 TMPDIR 隔离：findWorkDir 向上找 .clwriting/，若共享 /tmp 被污染
// （环境里存在 /tmp/.clwriting）会让"期望找不到"的断言失败。
// 关键：隔离根必须建在祖先链无 .clwriting 的位置（项目下，已验证干净），
// 而非 /tmp 子树（否则向上查找仍会越过隔离根命中 /tmp/.clwriting）。
// 把本套件 TMPDIR 重定向到它，文件内所有 tmpdir() 调用自动落到干净链。用完即删。
const ORIG_TMPDIR = process.env.TMPDIR
const REPO_ROOT = ORIG_CWD
let isoTmp: string
beforeAll(() => {
  // 父目录=项目根（存在），模板叶子随机；建在项目下保证祖先链无 .clwriting
  isoTmp = mkdtempSync(join(REPO_ROOT, '.vitest-resolve-'))
  process.env.TMPDIR = isoTmp
})
afterAll(() => {
  // 原环境无 TMPDIR（部分 Linux）时恢复为「删除变量」而非赋值——直接赋 undefined
  // 会落成字符串 "undefined"，污染后续 tmpdir() 调用
  if (ORIG_TMPDIR === undefined) delete process.env.TMPDIR
  else process.env.TMPDIR = ORIG_TMPDIR
  rmSync(isoTmp, { recursive: true, force: true })
})

function makeBookRepo(root: string): void {
  execSync('git init', { cwd: root, stdio: 'pipe' })
  execSync('git config user.email t@t.com', { cwd: root, stdio: 'pipe' })
  execSync('git config user.name t', { cwd: root, stdio: 'pipe' })
  execSync('git config commit.gpgsign false', { cwd: root, stdio: 'pipe' })
  writeFileSync(join(root, 'book.yaml'), 'spec_version: 1\n', 'utf-8')
  execSync('git add -A && git commit -m init', { cwd: root, stdio: 'pipe' })
}

function makeWorkDir(root: string): void {
  mkdirSync(join(root, '.clwriting'), { recursive: true })
}

beforeEach(() => {
  process.chdir(ORIG_CWD)
})

afterEach(() => {
  process.chdir(ORIG_CWD)
})

function cleanupTempDir(root: string): void {
  process.chdir(ORIG_CWD)
  rmSync(root, { recursive: true, force: true })
}

test('findWorkDir: 向上找含 .clwriting/ 的目录', () => {
  const root = mkdtempTracked(join(tmpdir(), 'wd-'))
  makeWorkDir(root)
  const sub = join(root, '书A', '定稿', '正文')
  mkdirSync(sub, { recursive: true })
  expect(findWorkDir(sub)).toBe(root)
  rmSync(root, { recursive: true, force: true })
})

test('findWorkDir: 无 .clwriting/ 返回 null', () => {
  const root = mkdtempTracked(join(tmpdir(), 'nwd-'))
  expect(findWorkDir(root)).toBeNull()
  rmSync(root, { recursive: true, force: true })
})

test('isBookRepo: 有 book.yaml + .git 才是书仓库', () => {
  const root = mkdtempTracked(join(tmpdir(), 'br-'))
  makeBookRepo(root)
  expect(isBookRepo(root)).toBe(true)
  // 仅工作目录（无 book.yaml）不是书仓库
  const wd = mkdtempTracked(join(tmpdir(), 'wd2-'))
  makeWorkDir(wd)
  expect(isBookRepo(wd)).toBe(false)
  rmSync(root, { recursive: true, force: true })
  cleanupTempDir(wd)
})

// ── books.jsonl 读写 ──────────────────────────────

test('readBooks: 缺文件返回空', () => {
  const wd = mkdtempTracked(join(tmpdir(), 'rb-'))
  expect(readBooks(wd)).toEqual([])
  rmSync(wd, { recursive: true, force: true })
})

test('readBooks: 坏行跳过不崩', () => {
  const wd = mkdtempTracked(join(tmpdir(), 'rb2-'))
  makeWorkDir(wd)
  writeFileSync(
    join(wd, '.clwriting', 'books.jsonl'),
    '{"name":"A","path":"A","kind":"long"}\n' + '这不是JSON\n' + '{"name":"B","path":"B","kind":"short"}\n' + '\n',
    'utf-8',
  )
  const books = readBooks(wd)
  expect(books).toHaveLength(2)
  expect(books[0]!.name).toBe('A')
  expect(books[1]!.name).toBe('B')
  expect(books[1]!.kind).toBe('short')
  rmSync(wd, { recursive: true, force: true })
})

test('readBooks: 保留未知字段，便于 books.jsonl 向后兼容', () => {
  const wd = mkdtempTracked(join(tmpdir(), 'rb3-'))
  makeWorkDir(wd)
  writeFileSync(
    join(wd, '.clwriting', 'books.jsonl'),
    '{"name":"A","path":"A","kind":"long","note":"保留我","extra":7}\n',
    'utf-8',
  )
  const books = readBooks(wd)
  expect(books).toHaveLength(1)
  expect(books[0]!.note).toBe('保留我')
  expect(books[0]!.extra).toBe(7)
  rmSync(wd, { recursive: true, force: true })
})

test('appendBook: 同名冲突拒绝', () => {
  const wd = mkdtempTracked(join(tmpdir(), 'ab-'))
  makeWorkDir(wd)
  const entry: BookEntry = { name: '书X', path: '书X', kind: 'long' }
  expect(appendBook(wd, entry).ok).toBe(true)
  const dup = appendBook(wd, entry)
  expect(dup.ok).toBe(false)
  if (!dup.ok) expect(dup.reason).toContain('书X')
  rmSync(wd, { recursive: true, force: true })
})

test('active 读写: 活动书指针', () => {
  const wd = mkdtempTracked(join(tmpdir(), 'ac-'))
  makeWorkDir(wd)
  expect(readActive(wd)).toBeNull()
  writeActive(wd, '书A')
  expect(readActive(wd)).toBe('书A')
  rmSync(wd, { recursive: true, force: true })
})
