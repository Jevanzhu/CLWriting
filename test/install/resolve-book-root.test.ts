import { test, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { execSync } from 'node:child_process'
import {
  resolveBookRoot,
  readBooks,
  writeBooks,
  appendBook,
  readActive,
  writeActive,
  findWorkDir,
  isBookRepo,
  type BookEntry,
} from '../../src/install/books.js'

// resolveBookRoot 依赖 process.cwd()，测试用 chdir 隔离
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
  process.env.TMPDIR = ORIG_TMPDIR
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

test('findWorkDir: 向上找含 .clwriting/ 的目录', () => {
  const root = mkdtempSync(join(tmpdir(), 'wd-'))
  makeWorkDir(root)
  const sub = join(root, '书A', '定稿', '正文')
  mkdirSync(sub, { recursive: true })
  expect(findWorkDir(sub)).toBe(root)
  rmSync(root, { recursive: true, force: true })
})

test('findWorkDir: 无 .clwriting/ 返回 null', () => {
  const root = mkdtempSync(join(tmpdir(), 'nwd-'))
  expect(findWorkDir(root)).toBeNull()
  rmSync(root, { recursive: true, force: true })
})

test('isBookRepo: 有 book.yaml + .git 才是书仓库', () => {
  const root = mkdtempSync(join(tmpdir(), 'br-'))
  makeBookRepo(root)
  expect(isBookRepo(root)).toBe(true)
  // 仅工作目录（无 book.yaml）不是书仓库
  const wd = mkdtempSync(join(tmpdir(), 'wd2-'))
  makeWorkDir(wd)
  expect(isBookRepo(wd)).toBe(false)
  rmSync(root, { recursive: true, force: true })
  rmSync(wd, { recursive: true, force: true })
})

test('resolveBookRoot 优先级: 显式参数 > 活动书（工作目录内）', () => {
  const wd = mkdtempSync(join(tmpdir(), 'wd3-'))
  makeWorkDir(wd)
  const bookA = join(wd, '书A')
  const bookB = join(wd, '书B')
  mkdirSync(bookA, { recursive: true })
  makeBookRepo(bookA)
  mkdirSync(bookB, { recursive: true })
  makeBookRepo(bookB)
  // 设活动书为 B
  writeBooks(wd, [
    { name: '书A', path: '书A', kind: 'long' },
    { name: '书B', path: '书B', kind: 'long' },
  ])
  writeActive(wd, '书B')
  process.chdir(wd)

  // 显式参数 A 覆盖活动书 B
  const r1 = resolveBookRoot(['书A'])
  expect(r1.ok).toBe(true)
  if (r1.ok) expect(r1.bookRoot).toBe(resolve(bookA))

  // 无显式参数 → 活动书 B
  const r2 = resolveBookRoot([])
  expect(r2.ok).toBe(true)
  if (r2.ok) expect(r2.bookRoot).toBe(bookB)

  rmSync(wd, { recursive: true, force: true })
})

test('resolveBookRoot 优先级: cwd 是书仓库时优先于 active', () => {
  const wd = mkdtempSync(join(tmpdir(), 'wd3b-'))
  makeWorkDir(wd)
  const bookA = join(wd, '书A')
  const bookB = join(wd, '书B')
  mkdirSync(bookA, { recursive: true })
  makeBookRepo(bookA)
  mkdirSync(bookB, { recursive: true })
  makeBookRepo(bookB)
  writeBooks(wd, [
    { name: '书A', path: '书A', kind: 'long' },
    { name: '书B', path: '书B', kind: 'long' },
  ])
  writeActive(wd, '书B')
  process.chdir(bookA)

  const r = resolveBookRoot([])
  expect(r.ok).toBe(true)
  if (r.ok) expect(r.bookRoot).toBe(bookA)

  rmSync(wd, { recursive: true, force: true })
})

test('resolveBookRoot 优先级 3: cwd 是书仓库时直接用（兼容书仓库内跑）', () => {
  const book = mkdtempSync(join(tmpdir(), 'bk-'))
  makeBookRepo(book)
  process.chdir(book)

  // cwd 是书仓库，无工作目录/活动书 → 直接用 cwd
  const r = resolveBookRoot([])
  expect(r.ok).toBe(true)
  if (r.ok) expect(r.bookRoot).toBe(book)

  rmSync(book, { recursive: true, force: true })
})

test('resolveBookRoot 优先级 4: 都不是 → 人话报错', () => {
  const empty = mkdtempSync(join(tmpdir(), 'em-'))
  process.chdir(empty) // 既非工作目录也非书仓库
  const r = resolveBookRoot([])
  expect(r.ok).toBe(false)
  if (!r.ok) {
    expect(r.reason).toContain('选书')
    expect(r.reason).toContain('init')
  }
  rmSync(empty, { recursive: true, force: true })
})

test('resolveBookRoot: 草稿位置参(.md)不误判为书目录', () => {
  const book = mkdtempSync(join(tmpdir(), 'bk2-'))
  makeBookRepo(book)
  process.chdir(book)
  // args 含 .md 草稿文件，不应被当书目录解析（应回落 cwd）
  const r = resolveBookRoot(['草稿-1.md'])
  expect(r.ok).toBe(true)
  if (r.ok) expect(r.bookRoot).toBe(book)
  rmSync(book, { recursive: true, force: true })
})

test('resolveBookRoot: 纯数字位置参不误判为书目录', () => {
  const book = mkdtempSync(join(tmpdir(), 'bk-num-'))
  makeBookRepo(book)
  process.chdir(book)
  // 纯数字通常是章号/篇号/批量数量，应回落 cwd 书仓库。
  const r = resolveBookRoot(['2'])
  expect(r.ok).toBe(true)
  if (r.ok) expect(r.bookRoot).toBe(book)
  rmSync(book, { recursive: true, force: true })
})

test('resolveBookRoot: explicitBookRoot 参数优先', () => {
  const book = mkdtempSync(join(tmpdir(), 'bk3-'))
  makeBookRepo(book)
  const r = resolveBookRoot(undefined, book)
  expect(r.ok).toBe(true)
  if (r.ok) expect(r.bookRoot).toBe(book)
  rmSync(book, { recursive: true, force: true })
})

// ── books.jsonl 读写 ──────────────────────────────

test('readBooks: 缺文件返回空', () => {
  const wd = mkdtempSync(join(tmpdir(), 'rb-'))
  expect(readBooks(wd)).toEqual([])
  rmSync(wd, { recursive: true, force: true })
})

test('readBooks: 坏行跳过不崩', () => {
  const wd = mkdtempSync(join(tmpdir(), 'rb2-'))
  makeWorkDir(wd)
  writeFileSync(
    join(wd, '.clwriting', 'books.jsonl'),
    '{"name":"A","path":"A","kind":"long"}\n' +
      '这不是JSON\n' +
      '{"name":"B","path":"B","kind":"short"}\n' +
      '\n',
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
  const wd = mkdtempSync(join(tmpdir(), 'rb3-'))
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
  const wd = mkdtempSync(join(tmpdir(), 'ab-'))
  makeWorkDir(wd)
  const entry: BookEntry = { name: '书X', path: '书X', kind: 'long' }
  expect(appendBook(wd, entry).ok).toBe(true)
  const dup = appendBook(wd, entry)
  expect(dup.ok).toBe(false)
  if (!dup.ok) expect(dup.reason).toContain('书X')
  rmSync(wd, { recursive: true, force: true })
})

test('active 读写: 活动书指针', () => {
  const wd = mkdtempSync(join(tmpdir(), 'ac-'))
  makeWorkDir(wd)
  expect(readActive(wd)).toBeNull()
  writeActive(wd, '书A')
  expect(readActive(wd)).toBe('书A')
  rmSync(wd, { recursive: true, force: true })
})
