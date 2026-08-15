/**
 * 工具面扩展单测：rewrite 工具入参校验与选段定位（不触发 AI）。
 */
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { makeDualTrackWorkdir, LONG_BOOK } from '../../studio/fixtures.js'
import { rewriteChapter, rewriteSelection } from '../../../src/ai/tools/rewrite.js'
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

describe('rewrite_chapter 入参校验', () => {
  it('缺 chapter → 拒绝', async () => {
    const r = await rewriteChapter(ctx(), { instruction: '压缩' })
    expect(r.ok).toBe(false)
  })
  it('缺 instruction → 拒绝', async () => {
    const r = await rewriteChapter(ctx(), { chapter: 1 })
    expect(r.ok).toBe(false)
  })
  it('章不存在 → 拒绝', async () => {
    const r = await rewriteChapter(ctx(), { chapter: 99, instruction: '压缩' })
    expect(r.ok).toBe(false)
  })
})

describe('rewrite_selection 入参校验', () => {
  it('缺 selection → 拒绝', async () => {
    const r = await rewriteSelection(ctx(), { chapter: 1, instruction: '改' })
    expect(r.ok).toBe(false)
  })
  it('选段不在正文 → 拒绝', async () => {
    const r = await rewriteSelection(ctx(), { chapter: 1, selection: '不存在的原文', instruction: '改' })
    expect(r.ok).toBe(false)
    expect(r.summary).toContain('未在')
  })
})

