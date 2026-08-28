/**
 * 工具面扩展单测：harvest_style（learnFromBook 纯收割，不依赖 AI）。
 */
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { makeDualTrackWorkdir, LONG_BOOK } from '../../studio/fixtures.js'
import { harvestStyle } from '../../../src/ai/tools/style.js'
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

describe('harvest_style', () => {
  it('收割完成返回 ok 与摘要', async () => {
    const r = await harvestStyle(ctx(), {})
    expect(r.ok).toBe(true)
    expect(r.summary).toContain('文风收割')
  })
})

