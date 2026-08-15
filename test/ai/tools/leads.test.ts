/**
 * 工具面扩展单测：lead_update 入参校验与章不存在（不触发 AI）。
 */
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { makeDualTrackWorkdir, LONG_BOOK } from '../../studio/fixtures.js'
import { leadUpdate } from '../../../src/ai/tools/leads.js'
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

describe('lead_update', () => {
  it('缺 chapter → 拒绝', async () => {
    const r = await leadUpdate(ctx(), {})
    expect(r.ok).toBe(false)
  })
  it('章不存在 → not-found 文案', async () => {
    const r = await leadUpdate(ctx(), { chapter: 99 })
    expect(r.ok).toBe(false)
    expect(r.summary).toContain('不存在')
  })
})

