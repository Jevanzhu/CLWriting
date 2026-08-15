/**
 * 工具面扩展单测：chapter_status（fixture 书无缓存 db → 验证错误分支）。
 */
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { makeDualTrackWorkdir, LONG_BOOK } from '../../studio/fixtures.js'
import { chapterStatus } from '../../../src/ai/tools/status.js'
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

describe('chapter_status', () => {
  it('无缓存 db → 明确提示（不抛错）', () => {
    const r = chapterStatus(ctx(), {})
    expect(r.ok).toBe(false)
    expect(r.summary).toContain('.cache/index.db')
  })
})

