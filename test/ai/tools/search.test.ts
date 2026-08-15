/**
 * 工具面扩展单测：book_search。
 */
import { rmSync } from 'node:fs'
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
})

