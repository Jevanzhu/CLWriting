/**
 * 0918独立重评修复批（C005）回归：searchBookCore 内残留同步 existsSync 目录预判删除。
 *
 * 目录存在性由注入的 SearchFileIo 天然覆盖——listMd 两驱动侧 walk（walkMd/walkMdAsync）
 * 对不存在/不可解析起点 realpath 失败即空返，scope 目录缺失 → 该 scope 零命中，
 * 与修复前 `if (!existsSync(abs)) continue` 行为等价；同步/异步两侧一致且不抛。
 * 「全链 fs.promises」宣称（searchBookAsync 头注）随批逐字成立。
 */
import { afterEach, describe, expect, it } from 'vitest'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdtempTracked } from '../helpers/temp-dir.js'
import { searchBook, searchBookAsync } from '../../src/process/book-search.js'

let root = ''

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true })
  root = ''
})

/** 只建 设定/ 目录——写作/正文、大纲、工作区 全缺（scope 目录缺失形态） */
function makeBookWithoutBodyDir(): string {
  root = mkdtempTracked(join(tmpdir(), 'c005-search-nodir-'))
  mkdirSync(join(root, '设定'), { recursive: true })
  writeFileSync(join(root, '设定', '人物.md'), '林远，佩玉少年。\n', 'utf-8')
  return root
}

describe('0918独立重评修复批 C005：scope 目录不存在 → 零命中不抛', () => {
  it('同步版：scope=正文（目录缺失）零命中；scope=设定（在盘）正常命中', () => {
    const book = makeBookWithoutBodyDir()
    const miss = searchBook(book, '林远', '正文')
    expect(miss.results).toEqual([])
    expect(miss.truncated).toBeUndefined()
    const hit = searchBook(book, '林远', '设定')
    expect(hit.results).toHaveLength(1)
    expect(hit.results[0]!.path).toBe('设定/人物.md')
  })

  it('异步版：scope=正文（目录缺失）零命中；scope=all 只出在盘目录且不抛', async () => {
    const book = makeBookWithoutBodyDir()
    const miss = await searchBookAsync(book, '林远', '正文')
    expect(miss.results).toEqual([])
    const all = await searchBookAsync(book, '林远', 'all')
    // 缺失 scope 目录静默跳过（零命中），all 只聚合在盘的 设定/
    expect(all.results.map((r) => r.path)).toEqual(['设定/人物.md'])
    // 两侧同源：异步 all 与同步 all 结果一致
    expect(all.results).toEqual(searchBook(book, '林远', 'all').results)
  })
})
