/**
 * R71-17 回归：renameChapter 对无连字符章文件名的前缀派生。
 *
 * 修复前 `prefix = oldName.split('-')[0]` 未剥 .md——`番外.md`（front matter 带
 * 章号即合法形态，copyChapter 低-6 已修同款）会把整个文件名当前缀，产出
 * 「番外.md-新标题.md」双 .md 畸形名。修复口径与 copyChapter 低-6 一致：先剥 .md
 * 再 split；无连字符 → 无数值前缀可保，新名直接用净化后的新标题。
 */
import { existsSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { makeDualTrackWorkdir, LONG_BOOK } from '../../studio/fixtures.js'
import { renameChapter } from '../../../src/ai/tools/tree.js'
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

/** 写一个无清单登记的章文件（front matter 带章号即被 readChapterDir 识别） */
function writeBareChapter(file: string, no: number): void {
  writeFileSync(join(bookRoot, '写作/正文', file), `---\n章号: ${no}\n标题: 裸章\n---\n正文。`, 'utf8')
}

describe('R71-17：renameChapter 前缀派生先剥 .md（对齐 copyChapter 低-6 口径）', () => {
  it('无连字符名 番外.md → 新名直接用新标题（单一 .md，无双 .md 畸形名）', async () => {
    writeBareChapter('番外.md', 6)
    const r = await renameChapter(ctx(), { chapter: 6, newTitle: '温泉旅行' })
    expect(r.ok).toBe(true)
    expect(existsSync(join(bookRoot, '写作/正文', '温泉旅行.md'))).toBe(true)
    expect(existsSync(join(bookRoot, '写作/正文', '番外.md'))).toBe(false)
    // 畸形名（双 .md / 整名当前缀）不得出现
    expect(existsSync(join(bookRoot, '写作/正文', '番外.md-温泉旅行.md'))).toBe(false)
    expect(r.summary).toContain('温泉旅行.md')
    expect(r.summary).not.toContain('.md-')
  })

  it('常规名 0001-标题.md → 章号前缀保留，产物不变（回归锚）', async () => {
    const r = await renameChapter(ctx(), { chapter: 1, newTitle: '入门改名' })
    expect(r.ok).toBe(true)
    expect(existsSync(join(bookRoot, '写作/正文', '0001-入门改名.md'))).toBe(true)
    expect(existsSync(join(bookRoot, '写作/正文', '0001-初入宗门.md'))).toBe(false)
  })

  it('含连字符但无数值前缀的名 番外-特别篇.md → 连字符前段保留为前缀', async () => {
    writeBareChapter('番外-特别篇.md', 7)
    const r = await renameChapter(ctx(), { chapter: 7, newTitle: '温泉旅行' })
    expect(r.ok).toBe(true)
    expect(existsSync(join(bookRoot, '写作/正文', '番外-温泉旅行.md'))).toBe(true)
    expect(r.summary).not.toContain('.md-')
  })
})
