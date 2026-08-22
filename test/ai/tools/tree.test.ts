/**
 * 工具面扩展单测：树操作（move/rename/copy/delete_chapter）。
 * 用 makeDualTrackWorkdir 建的真实书仓库验证文件系统副作用。
 */
import { existsSync, rmSync, writeFileSync } from 'node:fs'
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

  it('低-6（第十轮）：常规名 0005-标题.md 复制 → 0005-标题 副本.md（单一 .md 结尾）', async () => {
    writeFileSync(
      join(bookRoot, '写作/正文', '0005-标题.md'),
      '---\n章号: 5\n标题: 标题\n---\n第五章正文。',
      'utf8',
    )
    const r = await copyChapter(ctx(), { chapter: 5 })
    expect(r.ok).toBe(true)
    expect(existsSync(join(bookRoot, '写作/正文/0005-标题 副本.md'))).toBe(true)
    expect(r.summary).toContain('0005-标题 副本.md')
    // 单一 .md 结尾——旧实现 split('-') 前缀派生对无连字符名会产出双 .md 畸形名
    expect(r.summary).not.toContain('.md-')
  })

  it('低-6（第十轮）：无连字符章文件名复制 → 「名 副本.md」合法产物（不再产出「名.md- 副本.md」）', async () => {
    // 无连字符章文件名（front matter 带章号即被 readChapterDir 识别）
    writeFileSync(join(bookRoot, '写作/正文', '番外.md'), '---\n章号: 6\n标题: 番外\n---\n番外正文。', 'utf8')
    const r = await copyChapter(ctx(), { chapter: 6 })
    expect(r.ok).toBe(true)
    expect(existsSync(join(bookRoot, '写作/正文/番外 副本.md'))).toBe(true)
    // 畸形名（双 .md / 「- 副本」空标题段）不得出现
    expect(existsSync(join(bookRoot, '写作/正文/番外.md- 副本.md'))).toBe(false)
    expect(r.summary).toContain('番外 副本.md')
    expect(r.summary).not.toContain('.md-')
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

