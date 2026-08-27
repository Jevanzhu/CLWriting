/**
 * R65-7（总六十五轮）回归：apply_spill 落盘前 sha 复验——初次校验（读正文+比对）与
 * 最终 saveDraft 之间存在竞态窗口（self-heal 并发写同章时旧基线可静默覆盖新稿）。
 *
 * shared.readChapterBody 以受控 mock 替身注入：第一次读（校验）返回旧基线，第二次读
 * （落盘前复验）返回被并发改写后的正文——模拟外部写恰落在两读之间。
 */
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makeDualTrackWorkdir, LONG_BOOK } from '../../studio/fixtures.js'
import { applySpill } from '../../../src/ai/tools/rewrite.js'
import { writeSpillFile } from '../../../src/process/spill.js'
import { readChapterBody } from '../../../src/ai/tools/shared.js'
import type { ToolContext } from '../../../src/ai/tools/context.js'

vi.mock('../../../src/ai/tools/shared.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/ai/tools/shared.js')>()
  return { ...actual, readChapterBody: vi.fn() }
})

let bookRoot: string
let workDir: string
let chapterPath: string

beforeEach(() => {
  workDir = makeDualTrackWorkdir()
  bookRoot = join(workDir, '长篇', LONG_BOOK)
  chapterPath = join(bookRoot, '写作/正文/0001-初入宗门.md')
  vi.mocked(readChapterBody).mockReset()
})

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true })
})

function ctx(): ToolContext {
  return { bookRoot, bookName: LONG_BOOK, userDataPath: null }
}

function sha(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex')
}

describe('R65-7：apply_spill 落盘前 sha 复验（竞态窗口收口）', () => {
  it('初次校验后正文被并发改写 → 复验失配拒绝落盘，盘上保持新稿', async () => {
    const rawBefore = readFileSync(chapterPath, 'utf8')
    const bodyBefore = rawBefore.split('---').pop()!.trim()
    // 模拟外部并发编辑（self-heal 写同章 / 作者手改）落在初次校验之后
    writeFileSync(chapterPath, rawBefore.replace('玉佩', '古镜'), 'utf8')
    const bodyAfter = readFileSync(chapterPath, 'utf8').split('---').pop()!.trim()
    const produced = '基于旧基线的改写稿。' + '内容。'.repeat(50)
    const locator = writeSpillFile(bookRoot, produced, { kind: 'rewrite' as const, chapter: 1, baseSha: sha(bodyBefore) })!
    // 读序模拟：初次校验读到旧基线（sha 过）；落盘前复验读到被改写后的正文（sha 失配）
    vi.mocked(readChapterBody).mockReturnValueOnce(bodyBefore).mockReturnValueOnce(bodyAfter)
    const r = await applySpill(ctx(), { chapter: 1, locator })
    expect(r.ok).toBe(false)
    expect(r.summary).toContain('复验失败')
    expect(r.summary).toContain('并发修改')
    const after = readFileSync(chapterPath, 'utf8')
    expect(after).toContain('古镜') // 新编辑保留
    expect(after).not.toContain('基于旧基线的改写稿') // 旧基线稿未覆盖
  })

  it('正文未被并发改动 → 两次读一致，复验通过照常落盘（复验确实发生）', async () => {
    const body = readFileSync(chapterPath, 'utf8').split('---').pop()!.trim()
    const produced = '无竞态的改写稿。' + '内容。'.repeat(50)
    const locator = writeSpillFile(bookRoot, produced, { kind: 'rewrite' as const, chapter: 1, baseSha: sha(body) })!
    vi.mocked(readChapterBody).mockReturnValue(body)
    const r = await applySpill(ctx(), { chapter: 1, locator })
    expect(r.ok).toBe(true)
    expect(vi.mocked(readChapterBody)).toHaveBeenCalledTimes(2) // 初次校验 + 落盘前复验
    expect(readFileSync(chapterPath, 'utf8')).toContain('无竞态的改写稿')
  })
})
