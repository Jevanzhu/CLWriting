/**
 * 工具面扩展单测：rewrite 工具入参校验与选段定位（不触发 AI）。
 * RB-AI-P1-1：补成功路径（mock runSpec）——改写全文 spill 落盘 + summary 带路径与字数。
 */
import { readdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makeDualTrackWorkdir, LONG_BOOK } from '../../studio/fixtures.js'
import { rewriteChapter, rewriteSelection, applySpill } from '../../../src/ai/tools/rewrite.js'
import { writeSpillFile } from '../../../src/process/spill.js'
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
      model: null,
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
      model: null,
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


// ── GG-P2-2：apply_spill 确认落盘通道（「确认满意后再说一声」承诺的兑现件）──

describe('apply_spill 确认落盘', () => {
  it('合法 locator → 全文替换正文落盘，front matter 原样保留', async () => {
    const chapterPath = join(bookRoot, '写作/正文/0001-初入宗门.md')
    const before = readFileSync(chapterPath, 'utf-8')
    expect(before).toContain('章号: 1') // fixture 带fm
    const produced = '确认后的改写全文。' + '新内容。'.repeat(50)
    const locator = writeSpillFile(bookRoot, produced)!
    const r = await applySpill(ctx(), { chapter: 1, locator })
    expect(r.ok).toBe(true)
    const after = readFileSync(chapterPath, 'utf-8')
    expect(after).not.toContain(before.split('---').pop()!.trim().slice(0, 10)) // 旧正文已被替换
    expect(after).toContain('确认后的改写全文。')
    expect(after).toContain('章号: 1') // fm 保留（未随 body 丢失）
  })
  it('locator 形状不合法 → 拒绝（路径穿越防御）', async () => {
    const r = await applySpill(ctx(), { chapter: 1, locator: '工作区/spills/../../book.yaml' })
    expect(r.ok).toBe(false)
    expect(r.summary).toContain('路径不合法')
  })
  it('locator 不存在 → 拒绝', async () => {
    const r = await applySpill(ctx(), { chapter: 1, locator: '工作区/spills/0123456789abcdef.md' })
    expect(r.ok).toBe(false)
    expect(r.summary).toContain('不存在')
  })
  it('章不存在 → 拒绝', async () => {
    const produced = 'x'
    const locator = writeSpillFile(bookRoot, produced)!
    const r = await applySpill(ctx(), { chapter: 99, locator })
    expect(r.ok).toBe(false)
    expect(r.summary).toContain('不存在')
  })
})

