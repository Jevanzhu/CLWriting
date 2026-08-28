import { test, expect } from 'vitest'
import { mkdirSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { repairBooks, readBooks, findWorkDir } from '../../src/install/books.js'
import { doInit } from '../../src/install/init.js'
import { mkdtempTracked } from '../helpers/temp-dir.js'

/** repairBooks：删 books.jsonl 后重建登记（核心自愈链路）。 */
test('repairBooks: 删 books.jsonl 后重建登记，含原 init 建的书', () => {
  const wd = mkdtempTracked(join(tmpdir(), 'repcli-'))
  doInit({ workDir: wd, name: '门面测书', genre: '玄幻' })
  // 删 books.jsonl 模拟登记丢失
  rmSync(join(wd, '.clwriting', 'books.jsonl'), { force: true })
  expect(existsSync(join(wd, '.clwriting', 'books.jsonl'))).toBe(false)

  const result = repairBooks(wd)

  expect(result.rebuilt.some((b) => b.name === '门面测书')).toBe(true)
  // repair 后 books.jsonl 应重建，含原 init 建的书
  expect(existsSync(join(wd, '.clwriting', 'books.jsonl'))).toBe(true)
  const books = readBooks(wd)
  expect(books.some((b) => b.name === '门面测书')).toBe(true)

  rmSync(wd, { recursive: true, force: true })
})

/** 非工作目录定位：不在 .clwriting/ 下 → findWorkDir 找不到。 */
test('repair: 非工作目录下 findWorkDir 定位不到', () => {
  // 注意：empty 建在项目下而非 tmpdir()——findWorkDir 向上找 .clwriting/，
  // 若 empty 在 /tmp 子树会命中环境里的 /tmp/.clwriting 污染源导致测试失败。
  const ORIG_CWD = process.cwd()
  const empty = join(ORIG_CWD, '.vitest-repair-empty-2')
  rmSync(empty, { recursive: true, force: true })
  mkdirSync(empty, { recursive: true })
  expect(findWorkDir(empty)).toBeNull()
  rmSync(empty, { recursive: true, force: true })
})

/** 登记完好 → 无变动，不改写。 */
test('repairBooks: 登记完好时无变动', () => {
  const wd = mkdtempTracked(join(tmpdir(), 'repcli3-'))
  doInit({ workDir: wd, name: '完好书', genre: '玄幻' })
  const before = readBooks(wd)
  const result = repairBooks(wd)
  expect(result.changed).toBe(false)
  expect(result.rebuilt).toEqual(before)
  rmSync(wd, { recursive: true, force: true })
})