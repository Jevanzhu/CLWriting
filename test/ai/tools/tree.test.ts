/**
 * 工具面扩展单测：树操作（move/rename/copy/delete_chapter）。
 * 用 makeDualTrackWorkdir 建的真实书仓库验证文件系统副作用。
 */
import { existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { makeDualTrackWorkdir, LONG_BOOK } from '../../studio/fixtures.js'
import { moveChapter, renameChapter, copyChapter, deleteChapter } from '../../../src/ai/tools/tree.js'
import type { ToolContext } from '../../../src/ai/tools/context.js'

let bookRoot: string
let workDir: string

beforeEach(() => {
  workDir = makeDualTrackWorkdir()
  bookRoot = join(workDir, '长篇', LONG_BOOK)
})

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true })
})

function ctx(): ToolContext {
  return { bookRoot, bookName: LONG_BOOK, userDataPath: null }
}

describe('move_chapter', () => {
  it('把章移动到新目录', async () => {
    const r = await moveChapter(ctx(), { chapter: 1, toDir: '写作/正文/第一卷' })
    expect(r.ok).toBe(true)
    expect(existsSync(join(bookRoot, '写作/正文/第一卷/0001-初入宗门.md'))).toBe(true)
  })
  it('目标目录缺省 → 拒绝', async () => {
    const r = await moveChapter(ctx(), { chapter: 1 })
    expect(r.ok).toBe(false)
  })
  it('章不存在 → 拒绝', async () => {
    const r = await moveChapter(ctx(), { chapter: 99, toDir: '写作/正文/第一卷' })
    expect(r.ok).toBe(false)
  })
})

describe('rename_chapter', () => {
  it('重命名章（章号前缀保留）', async () => {
    const r = await renameChapter(ctx(), { chapter: 1, newTitle: '入门改名' })
    expect(r.ok).toBe(true)
    expect(existsSync(join(bookRoot, '写作/正文/0001-入门改名.md'))).toBe(true)
    expect(existsSync(join(bookRoot, '写作/正文/0001-初入宗门.md'))).toBe(false)
  })
  it('缺新标题 → 拒绝', async () => {
    const r = await renameChapter(ctx(), { chapter: 1 })
    expect(r.ok).toBe(false)
  })
  it('标题含路径分隔符 → 净化不越出', async () => {
    const r = await renameChapter(ctx(), { chapter: 1, newTitle: '../越界' })
    expect(r.ok).toBe(true)
    expect(existsSync(join(bookRoot, '写作/正文/0001-.._越界.md'))).toBe(true)
  })
})

describe('copy_chapter', () => {
  it('复制章为副本（同目录）', async () => {
    const r = await copyChapter(ctx(), { chapter: 1 })
    expect(r.ok).toBe(true)
    expect(existsSync(join(bookRoot, '写作/正文/0001-初入宗门 副本.md'))).toBe(true)
  })
})

describe('delete_chapter', () => {
  it('软删章 → 回收站', async () => {
    const r = await deleteChapter(ctx(), { chapter: 2 })
    expect(r.ok).toBe(true)
    expect(existsSync(join(bookRoot, '写作/正文/0002-玉佩之秘.md'))).toBe(false)
  })
  it('章不存在 → 拒绝', async () => {
    const r = await deleteChapter(ctx(), { chapter: 99 })
    expect(r.ok).toBe(false)
  })
})

describe('入参校验', () => {
  it('chapter 非正整数 → 全部拒绝', async () => {
    for (const fn of [moveChapter, renameChapter, copyChapter, deleteChapter]) {
      const r = await fn(ctx(), { chapter: 'x' })
      expect(r.ok).toBe(false)
    }
  })
})

