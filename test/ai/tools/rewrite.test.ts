/**
 * 工具面扩展单测：rewrite 工具入参校验与选段定位（不触发 AI）。
 * RB-AI-P1-1：补成功路径（mock runSpec）——改写全文 spill 落盘 + summary 带路径与字数。
 */
import { readdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makeDualTrackWorkdir, LONG_BOOK } from '../../studio/fixtures.js'
import { rewriteChapter, rewriteSelection } from '../../../src/ai/tools/rewrite.js'
import { runSpec } from '../../../src/ai/tasks/spec.js'
import type { ToolContext } from '../../../src/ai/tools/context.js'

vi.mock('../../../src/ai/tasks/spec.js', () => ({ runSpec: vi.fn() }))

let bookRoot: string
let workDir: string

beforeEach(() => {
  workDir = makeDualTrackWorkdir()
  bookRoot = join(workDir, '长篇', LONG_BOOK)
  vi.mocked(runSpec).mockReset()
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

// ── RB-AI-P1-1：成功路径全文 spill（此前全文只余 600 字预览，确认后落盘物理不可达）──

describe('RB-AI-P1-1 改写全文 spill 落盘', () => {
  it('rewrite_chapter 成功 → 全文写入 工作区/spills，summary 含路径与字数', async () => {
    const produced = '改写后的第 1 章全文。' + '新稿内容。'.repeat(200)
    vi.mocked(runSpec).mockResolvedValue({
      ok: true,
      data: { input: { '正文': produced }, text: '', stopReason: 'tool_use' },
      ctrl: new AbortController(),
      usage: null,
      runId: 'rb-ai-p1-1',
    })
    const r = await rewriteChapter(ctx(), { chapter: 1, instruction: '压缩' })
    expect(r.ok).toBe(true)
    const spillDir = join(bookRoot, '工作区', 'spills')
    const files = readdirSync(spillDir)
    expect(files).toHaveLength(1)
    expect(readFileSync(join(spillDir, files[0]!), 'utf8')).toBe(produced)
    expect(r.summary).toContain('工作区/spills/')
    expect(r.summary).toContain(String(produced.length))
    expect(r.summary).toContain('【未保存】')
  })

  it('rewrite_selection 成功 → 同样 spill 全文，summary 含路径与字数', async () => {
    const produced = '改写后的选段。' + '润色稿。'.repeat(200)
    vi.mocked(runSpec).mockResolvedValue({
      ok: true,
      data: { input: { '正文': produced }, text: '', stopReason: 'tool_use' },
      ctrl: new AbortController(),
      usage: null,
      runId: 'rb-ai-p1-1',
    })
    const r = await rewriteSelection(ctx(), {
      chapter: 1,
      selection: '玉佩在胸前微微发光',
      instruction: '改',
    })
    expect(r.ok).toBe(true)
    const files = readdirSync(join(bookRoot, '工作区', 'spills'))
    expect(files).toHaveLength(1)
    expect(readFileSync(join(bookRoot, '工作区', 'spills', files[0]!), 'utf8')).toBe(produced)
    expect(r.summary).toContain('工作区/spills/')
    expect(r.summary).toContain(String(produced.length))
  })
})

