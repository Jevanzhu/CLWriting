/**
 * F1-P5（F2 批次）self-heal 预算/生成失败语义单测。
 *
 * F2 语义统一：无稿可交（首稿预算超限/生成失败）→ failed；有稿可交 → escalate（保留稿）。
 * 单章与批量同源（runChapter 唯一闭环），同一语义两侧一致。
 *
 * 用 vi.mock 隔离 checkAiCallBudget（真实实现读 .cache/ai-calls.json，静态文件无法
 * 区分首稿/重写两次调用；mock 返回序列可精确控制）。
 */
import { test, expect, vi, describe, beforeEach } from 'vitest'
import { join } from 'node:path'
import { makeDualTrackWorkdir, SHORT_BOOK } from '../studio/fixtures.js'
import { runSelfHeal, type SelfHealOpts } from '../../src/ai/orchestrate/self-heal.js'
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

interface SaveCall { content: string; origin?: string }

function makeSave(calls: SaveCall[]): typeof saveDraft {
  return (_bookRoot, _chapter, content, opts) => {
    calls.push({ content, ...(opts?.snapshotOrigin ? { origin: opts.snapshotOrigin } : {}) })
    return { relPath: '写作/正文/1-测试章.md', docId: 'doc-短篇-1', words: content.length, snapshotted: false }
  }
}

function makeEmitDriver(emitted: DriverEvent[]): StudioDriver {
  return {
    async startSession(cwd: string): Promise<Session> { return { id: 'mock', cwd, closed: false } },
    async *stream(): AsyncGenerator<DriverEvent> {},
    dispose(): void {},
    emit(_s, ev): void { emitted.push(ev) },
  }
}

function makeGenFn(texts: string[]): NonNullable<SelfHealOpts['genFn']> {
  let idx = 0
  return async (_prompt, _kind, _signal, onText) => {
    const t = texts[idx] ?? texts[texts.length - 1] ?? ''
    idx++
    if (onText && t) onText(t)
    return t
  }
}

interface Setup {
  opts: SelfHealOpts
  emitted: DriverEvent[]
  saves: SaveCall[]
}

function setup(
  texts: string[],
  check: (p: string) => CheckOutcome,
  extra?: Partial<SelfHealOpts>,
): Setup {
  const workDir = makeDualTrackWorkdir()
  const bookRoot = join(workDir, '短篇', SHORT_BOOK)
  const emitted: DriverEvent[] = []
  const driver = makeEmitDriver(emitted)
  const saves: SaveCall[] = []
  const opts: SelfHealOpts = {
    driver,
    mainSession: { id: 'main', cwd: workDir, closed: false },
    userDataPath: '/tmp/clwriting-test',
    cwd: workDir,
    bookRoot,
    bookName: BOOK,
    chapter: 1,
    check,
    save: makeSave(saves),
    genFn: makeGenFn(texts),
    ...extra,
  }
  return { opts, emitted, saves }
}

function evTypes(emitted: DriverEvent[]): string[] {
  return emitted.map((e) => e.type)
}

const budgetOk = { ok: true, used: 0, limit: 8 } as const
const budgetOver = { ok: false, used: 8, limit: 8, reason: '本章已调用 8 次（上限 8）。可临时提高 book.yaml 的 budget.calls_per_chapter' } as const

beforeEach(() => {
  vi.mocked(checkAiCallBudget).mockReset()
})

describe('F2 self-heal 语义统一（无稿 failed / 有稿 escalate）', () => {
  test('单章首稿预算超限 → failed（无稿可交）', async () => {
    vi.mocked(checkAiCallBudget).mockReturnValue(budgetOver)
    const { opts, emitted } = setup([FM + '正文'], () => greenOutcome())
    const r = await runSelfHeal(opts)

    expect(r.outcome).toBe('failed')
    if (r.outcome === 'failed') expect(r.error).toContain('上限')
    // 未生成任何稿子（无 save 调用）
    const types = evTypes(emitted)
    expect(types).not.toContain('self_heal_progress')
    const res = emitted.find((e) => e.type === 'self_heal_result') as { outcome?: string } | undefined
    expect(res?.outcome).toBe('failed')
  })

  test('批量首稿预算超限 → failed（与单章一致，非 escalate）+ batch_progress', async () => {
    vi.mocked(checkAiCallBudget).mockReturnValue(budgetOver)
    const { opts, emitted } = setup([FM + '一章', FM + '二章'], () => greenOutcome(), { chapters: [1, 2] })
    const r = await runSelfHeal(opts)

    expect(r.outcome).toBe('failed')
    if (r.outcome === 'failed') expect(r.error).toContain('上限')
    // 停在第一章（done=0）
    const bp = emitted.find((e) => e.type === 'self_heal_batch_progress') as { done?: number; stoppedAt?: number } | undefined
    expect(bp).toBeTruthy()
    expect(bp?.done).toBe(0)
    expect(bp?.stoppedAt).toBe(1)
  })

  test('单章重写预算超限 → escalate（有稿可交，保留当前稿）', async () => {
    // 首稿 budget 正常 → 首稿红 → 重写前 budget 超限 → escalate
    vi.mocked(checkAiCallBudget)
      .mockReturnValueOnce(budgetOk)
      .mockReturnValueOnce(budgetOver)
    const { opts, emitted } = setup([FM + '首稿'], () => redOutcome())
    const r = await runSelfHeal(opts)

    expect(r.outcome).toBe('escalate')
    if (r.outcome === 'escalate') {
      expect(r.reds).toContain('命中禁词「顿时」')
      expect(r.reds.some((s) => s.includes('上限'))).toBe(true)
    }
    const res = emitted.find((e) => e.type === 'self_heal_result') as { outcome?: string } | undefined
    expect(res?.outcome).toBe('escalate')
  })

  test('批量重写预算超限 → escalate（有稿）+ 停后续章', async () => {
    // 章1 绿（pass）→ 章2 首稿红 → 重写前预算超限 → escalate 停在章2
    vi.mocked(checkAiCallBudget)
      .mockReturnValueOnce(budgetOk) // 章1 首稿
      .mockReturnValueOnce(budgetOk) // 章2 首稿
      .mockReturnValueOnce(budgetOver) // 章2 重写
    const seq = [greenOutcome(), redOutcome('二章禁词'), redOutcome('二章禁词')]
    let i = 0
    const { opts, emitted } = setup(
      [FM + '一章', FM + '二章'],
      () => seq[Math.min(i++, seq.length - 1)]!,
      { chapters: [1, 2] },
    )
    const r = await runSelfHeal(opts)

    expect(r.outcome).toBe('escalate')
    if (r.outcome === 'escalate') expect(r.chapter).toBe(2)
    const bp = emitted.find((e) => e.type === 'self_heal_batch_progress') as { done?: number } | undefined
    expect(bp?.done).toBe(1) // 已完成章1
  })

  test('单章首稿生成失败 → failed（无稿）', async () => {
    vi.mocked(checkAiCallBudget).mockReturnValue(budgetOk)
    const genFn: NonNullable<SelfHealOpts['genFn']> = async () => {
      throw new Error('AI 服务不可用')
    }
    const workDir = makeDualTrackWorkdir()
    const emitted: DriverEvent[] = []
    const driver = makeEmitDriver(emitted)
    const opts: SelfHealOpts = {
      driver,
      mainSession: { id: 'main', cwd: workDir, closed: false },
      userDataPath: '/tmp/clwriting-test',
      cwd: workDir,
      bookRoot: join(workDir, '短篇', SHORT_BOOK),
      bookName: BOOK,
      chapter: 1,
      check: () => greenOutcome(),
      genFn,
    }
    const r = await runSelfHeal(opts)

    expect(r.outcome).toBe('failed')
    if (r.outcome === 'failed') expect(r.error).toContain('不可用')
  })
})
