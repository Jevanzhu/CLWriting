import { test, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execSync } from 'node:child_process'
import { repairCommand } from '../../src/cli/repair.js'
import { readBooks } from '../../src/install/books.js'
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

test('repair CLI: 删 books.jsonl 后 repair 重建（端到端门面）', () => {
  const wd = mkdtempSync(join(tmpdir(), 'repcli-'))
  doInit({ workDir: wd, name: '门面测书', genre: '玄幻' })
  // 删 books.jsonl 模拟登记丢失
  rmSync(join(wd, '.clwriting', 'books.jsonl'), { force: true })
  expect(existsSync(join(wd, '.clwriting', 'books.jsonl'))).toBe(false)

  // chdir 到工作目录跑 repair（门面用 findWorkDir(cwd) 定位）
  process.chdir(wd)
  repairCommand([])

  // repair 后 books.jsonl 应重建，含原 init 建的书
  expect(existsSync(join(wd, '.clwriting', 'books.jsonl'))).toBe(true)
  const books = readBooks(wd)
  expect(books.some((b) => b.name === '门面测书')).toBe(true)

  rmSync(wd, { recursive: true, force: true })
})

test('repair CLI: 无工作目录时退出非零（不在 .clwriting/ 下）', () => {
  const empty = mkdtempSync(join(tmpdir(), 'repcli2-'))
  process.chdir(empty)
  // 门面 console.error + process.exit(1)；测试期望它抛（exit 被测试运行时转抛）
  expect(() => repairCommand([])).toThrow()
  rmSync(empty, { recursive: true, force: true })
})

test('repair CLI: 登记完好时报「无需修复」', () => {
  const wd = mkdtempSync(join(tmpdir(), 'repcli3-'))
  doInit({ workDir: wd, name: '完好书', genre: '玄幻' })
  process.chdir(wd)
  // 登记有效，repair 应报完好不改动
  const before = readBooks(wd)
  repairCommand([])
  const after = readBooks(wd)
  expect(after).toEqual(before)
  rmSync(wd, { recursive: true, force: true })
})
