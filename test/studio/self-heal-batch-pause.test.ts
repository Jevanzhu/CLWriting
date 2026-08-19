/**
 * M6 #34 连写暂停元状态 · 驱动侧接线单测（评审 4.1-3：读侧就绪、驱动侧未接 → 本批接上）。
 *
 * self-heal orchestrateBatch 与 工作区/待定稿/.auto-batch.json 的契约：
 * - 开批即清旧暂停记录（重开=作者已处置上次的停）
 * - 中途停（aborted/failed/escalate）→ 落 paused{at_chapter, reason, detail}
 * - 全部写完 → 无暂停记录
 * 读侧（state.ts buildRecap → StatusRecap.batchPause）由 batch-pause 模块单测与
 * state 既有测试覆盖，此处只验驱动侧落盘行为。
 *
 * 替身模式沿用 self-heal-f2.test.ts：vi.mock checkAiCallBudget（预算闸可控）、
 * check/save/genFn 注入，双轨工作区（短篇书）。
 */
import { test, expect, vi, describe, beforeEach, afterEach } from 'vitest'
import { join } from 'node:path'
import { existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { makeDualTrackWorkdir, SHORT_BOOK } from '../studio/fixtures.js'
import { runSelfHeal, abortSelfHeal, type SelfHealOpts } from '../../src/ai/orchestrate/self-heal.js'
import { readBatchPause, writeBatchPause } from '../../src/state/batch-pause.js'
import type { CheckOutcome } from '../../src/studio/server/api/check.js'
import type { DriverEvent, Session, StudioDriver } from '../../src/driver/index.js'
import type { ChapterMeta } from '../../src/format/types.js'
import type { saveDraft } from '../../src/studio/server/api/draft.js'
import { checkAiCallBudget } from '../../src/ai/calls.js'

vi.mock('../../src/ai/calls.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/ai/calls.js')>()
  return { ...actual, checkAiCallBudget: vi.fn() }
})

const BOOK = SHORT_BOOK
const META: ChapterMeta = {
  章号: 1,
  标题: '测试章',
  钩子类型: '悬念钩',
  钩子强弱: '中',
  情绪定位: '铺垫',
}
const FM = '---\n章号: 1\n标题: 测试章\n---\n'

function greenOutcome(): CheckOutcome {
  return { ok: true, report: { sections: [] }, hasRed: false, chapter: META, body: '正文' }
}
function redOutcome(msg = '命中禁词「顿时」'): CheckOutcome {
  return {
    ok: true,
    report: { sections: [{ name: '禁词', items: [{ checkId: 'banned-word', level: 'red', message: msg }] }] },
    hasRed: true,
    chapter: META,
    body: '正文',
  }
}

function makeSave(): typeof saveDraft {
  return (_bookRoot, _chapter, content) => ({
    relPath: '写作/正文/1-测试章.md',
    docId: 'doc-短篇-1',
    words: content.length,
    snapshotted: false,
  })
}

function makeEmitDriver(emitted: DriverEvent[]): StudioDriver {
  return {
    async startSession(cwd: string): Promise<Session> {
      return { id: 'mock', cwd, closed: false }
    },
    async *stream(): AsyncGenerator<DriverEvent> {},
    dispose(): void {},
    emit(_s, ev): void {
      emitted.push(ev)
    },
  }
}

interface Setup {
  opts: SelfHealOpts
  bookRoot: string
  workDir: string
}

function setup(
  texts: string[],
  check: (p: string) => CheckOutcome,
  extra?: Partial<SelfHealOpts>,
): Setup {
  const workDir = makeDualTrackWorkdir()
  const bookRoot = join(workDir, '短篇', SHORT_BOOK)
  const emitted: DriverEvent[] = []
  let idx = 0
  const genFn = async (_prompt: string, _kind: 'long' | 'short', _signal: AbortSignal, onText: (d: string) => void) => {
    const t = texts[idx] ?? texts[texts.length - 1] ?? ''
    idx++
    if (onText && t) onText(t)
    return t
  }
  const opts: SelfHealOpts = {
    driver: makeEmitDriver(emitted),
    mainSession: { id: 'main', cwd: workDir, closed: false },
    userDataPath: join(tmpdir(), 'clwriting-test'),
    cwd: workDir,
    bookRoot,
    bookName: BOOK,
    chapter: 1,
    check,
    save: makeSave(),
    genFn,
    ...extra,
  }
  return { opts, bookRoot, workDir }
}

const budgetOk = { ok: true, used: 0, limit: 8 } as const
const budgetOver = { ok: false, used: 8, limit: 8, reason: '本章已调用 8 次（上限 8）。可临时提高 book.yaml 的 budget.calls_per_chapter' } as const

const cleanup: string[] = []
afterEach(() => {
  while (cleanup.length > 0) rmSync(cleanup.pop()!, { recursive: true, force: true })
})

beforeEach(() => {
  vi.mocked(checkAiCallBudget).mockReset()
  vi.mocked(checkAiCallBudget).mockReturnValue(budgetOk)
})

describe('M6 #34 连写暂停元状态：驱动侧接线', () => {
  test('批量 escalate 停中途 → 落 paused{at_chapter=停章, reason=escalate, detail=红项}', async () => {
    // 章1 绿 → 章2 恒红 → 触顶 escalate 停在章2
    const seq = [greenOutcome(), redOutcome('二章禁词「顿时」')]
    let i = 0
    const { opts, bookRoot, workDir } = setup([FM + '一章', FM + '二章'], () => seq[Math.min(i++, seq.length - 1)]!, {
      chapters: [1, 2],
    })
    cleanup.push(workDir)
    const r = await runSelfHeal(opts)

    expect(r.outcome).toBe('escalate')
    const p = readBatchPause(bookRoot)
    expect(p).toBeDefined()
    expect(p?.atChapter).toBe(2)
    expect(p?.reason).toBe('escalate')
    expect(p?.detail).toContain('顿时')
  })

  test('批量 failed（首稿预算超限）→ paused{reason=failed, detail 含上限原因}', async () => {
    vi.mocked(checkAiCallBudget).mockReturnValue(budgetOver)
    const { opts, bookRoot, workDir } = setup([FM + '一章'], () => greenOutcome(), { chapters: [1, 2] })
    cleanup.push(workDir)
    const r = await runSelfHeal(opts)

    expect(r.outcome).toBe('failed')
    const p = readBatchPause(bookRoot)
    expect(p?.atChapter).toBe(1)
    expect(p?.reason).toBe('failed')
    expect(p?.detail).toContain('上限')
  })

  test('批量中止（章2 生成期 abort）→ paused{reason=aborted}', async () => {
    // 章1 绿；章2 genFn 里 abortSelfHeal → 生成后 signal 检查 → aborted 停在章2
    let call = 0
    const genFn = async (_prompt: string, _kind: 'long' | 'short', _signal: AbortSignal, onText: (d: string) => void) => {
      call++
      if (call === 2) abortSelfHeal(BOOK)
      const t = FM + `第${call}章正文`
      if (onText) onText(t)
      return t
    }
    const workDir = makeDualTrackWorkdir()
    cleanup.push(workDir)
    const bookRoot = join(workDir, '短篇', SHORT_BOOK)
    const emitted: DriverEvent[] = []
    const opts: SelfHealOpts = {
      driver: makeEmitDriver(emitted),
      mainSession: { id: 'main', cwd: workDir, closed: false },
      userDataPath: join(tmpdir(), 'clwriting-test'),
      cwd: workDir,
      bookRoot,
      bookName: BOOK,
      chapter: 1,
      check: () => greenOutcome(),
      save: makeSave(),
      genFn,
      chapters: [1, 2],
    }
    const r = await runSelfHeal(opts)

    expect(r.outcome).toBe('aborted')
    const p = readBatchPause(bookRoot)
    expect(p?.atChapter).toBe(2)
    expect(p?.reason).toBe('aborted')
  })

  test('开批清旧暂停 + 全部写完 → 无暂停记录（文件不存在）', async () => {
    // 预置陈旧暂停记录（上次连写遗留）→ 重开批量全绿 → 记录被清、跑完不再落
    const { opts, bookRoot, workDir } = setup([FM + '一章', FM + '二章'], () => greenOutcome(), { chapters: [1, 2] })
    cleanup.push(workDir)
    const stale = join(bookRoot, '工作区', '待定稿', '.auto-batch.json')
    writeBatchPause(bookRoot, { atChapter: 1, reason: 'escalate', detail: '上次遗留' })
    expect(existsSync(stale)).toBe(true)

    const r = await runSelfHeal(opts)

    expect(r.outcome).toBe('pass')
    expect(existsSync(stale)).toBe(false)
    expect(readBatchPause(bookRoot)).toBeUndefined()
  })
})
