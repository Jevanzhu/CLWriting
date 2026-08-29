/**
 * 工具面扩展单测：book_search。
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { makeDualTrackWorkdir, LONG_BOOK } from '../../studio/fixtures.js'
import { bookSearch } from '../../../src/ai/tools/search.js'
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

describe('book_search', () => {
  it('命中正文关键词', () => {
    const r = bookSearch(ctx(), { query: '玉佩' })
    expect(r.ok).toBe(true)
    expect(r.summary).toContain('玉佩')
    expect(r.summary).toContain('0001-初入宗门')
  })
  it('scope=设定 只搜设定目录', () => {
    const r = bookSearch(ctx(), { query: '玉佩', scope: '设定' })
    expect(r.ok).toBe(true)
    expect(r.summary).toContain('设定/伏笔/玉佩线索')
    expect(r.summary).not.toContain('0001-初入宗门')
  })
  it('无命中 → ok 且提示未找到', () => {
    const r = bookSearch(ctx(), { query: '不存在的词xyz' })
    expect(r.ok).toBe(true)
    expect(r.summary).toContain('未找到')
  })
  it('缺 query → 拒绝', () => {
    const r = bookSearch(ctx(), {})
    expect(r.ok).toBe(false)
  })

  // R75-A-P3c（批 A）：命中行截断按码位不按 UTF-16 码元——slice(0,60) 在增补平面
  // 字符（emoji）边界切出半个代理对（下游渲染乱码）。
  it('R75-A-P3c: 含 emoji 的命中行按码位截断（不切出半个代理对）', () => {
    // 4 个汉字 + 80 个 emoji：UTF-16 第 60 个码元恰落在第 29 个 emoji 的高代理项上——
    // slice(0,60) 截出孤立高代理项；码位截断 = 4 汉字 + 56 个完整 emoji（60 码位）
    const line = '独有词条' + '😀'.repeat(80)
    mkdirSync(join(bookRoot, '设定'), { recursive: true })
    writeFileSync(join(bookRoot, '设定', 'emoji-线索.md'), line + '\n', 'utf-8')
    const r = bookSearch(ctx(), { query: '独有词条' })
    expect(r.ok).toBe(true)
    // 取 '· ' 打点的命中行（首行「找到 N 处…」头部也含搜索词，不能作截断对象）
    const row = r.summary.split('\n').find((l) => l.startsWith('· ') && l.includes('emoji-线索'))!
    const excerpt = row.slice(row.indexOf('：') + 1)
    // 截断长度按码位计 60；末尾是完整 emoji（非孤立代理项）
    expect(Array.from(excerpt).length).toBe(60)
    expect(excerpt.endsWith('😀')).toBe(true)
    // 反证旧实现：slice 的奇数边界落在第 29 个 emoji 的高代理项上（4 汉字 + 28 完整
    // emoji = 60 码元整，slice(0,60) 恰完整收尾不切——反证取 61 才切出孤立高代理项）
    expect(line.slice(0, 61).endsWith('😀')).toBe(false)
  })
})

