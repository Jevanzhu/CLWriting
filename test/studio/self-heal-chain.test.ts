/**
 * F1-P2 self-heal 链路事件单测：机检报告（check/report）与打回评估（retry/attempt）
 * 写入事件库 workspace 会话；红→绿 与 escalate 两路径覆盖。
 */
import { test, expect } from 'vitest'
import { mkdirSync, writeFileSync, rmSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeDualTrackWorkdir, SHORT_BOOK } from '../studio/fixtures.js'
import { runSelfHeal, type SelfHealOpts } from '../../src/ai/orchestrate/self-heal.js'
import { openSessionStore, bookHash } from '../../src/events/store.js'
import type { CheckOutcome } from '../../src/studio/server/api/check.js'
import type { DriverEvent, Session, StudioDriver } from '../../src/driver/index.js'
import type { ChapterMeta } from '../../src/format/types.js'
import type { saveDraft } from '../../src/studio/server/api/draft.js'

const BOOK = SHORT_BOOK
const META: ChapterMeta = { 章号: 1, 标题: '测试章', 钩子类型: '悬念钩', 钩子强弱: '中', 情绪定位: '铺垫' }

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

function makeGenFn(texts: string[]): NonNullable<SelfHealOpts['genFn']> {
  let idx = 0
  return async (_prompt, _kind, _signal, onText) => {
    const t = texts[idx] ?? texts[texts.length - 1] ?? ''
    idx++
    if (onText && t) onText(t)
    return t
  }
}

function makeSave(): typeof saveDraft {
  return (bookRoot, _chapter, content, _opts) => {
    const dir = join(bookRoot, '写作', '正文')
    const relPath = '写作/正文/1-测试章.md'
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(bookRoot, relPath), content, 'utf8')
    return { relPath, docId: 'doc-短篇-1', words: content.length, snapshotted: false }
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

function readChain(ud: string, bookRoot: string) {
  const store = openSessionStore(ud, bookRoot)!
  try {
    return store.listEvents(bookHash(bookRoot))
  } finally {
    store.close()
  }
}

test('红→绿：check/report（含红项）+ retry/attempt 落库，最终 pass', async () => {
  const workDir = makeDualTrackWorkdir()
  const bookRoot = join(workDir, '短篇', SHORT_BOOK)
  const ud = mkdtempSync(join(tmpdir(), 'clwriting-sh-chain-'))
  try {
    const emitted: DriverEvent[] = []
    let checks = 0
    const opts: SelfHealOpts = {
      driver: makeEmitDriver(emitted),
      mainSession: { id: 'main', cwd: workDir, closed: false },
      userDataPath: ud,
      cwd: workDir,
      bookRoot,
      bookName: BOOK,
      chapter: 1,
      check: () => { checks++; return checks === 1 ? redOutcome() : greenOutcome() },
      save: makeSave(),
      genFn: makeGenFn(['第一稿', '第二稿']),
    }
    const r = await runSelfHeal(opts)
    expect(r.outcome).toBe('pass')

    const evs = readChain(ud, bookRoot)
    const types = evs.map((e) => e.type)
    // 首检红（第 1 稿）→ 重写 → 次检绿（第 2 稿）：两轮机检各一条 check/report，一次打回一次 retry/attempt
    expect(types.filter((t) => t === 'check/report')).toHaveLength(2)
    expect(types.filter((t) => t === 'retry/attempt')).toHaveLength(1)
    const first = evs.find((e) => e.type === 'check/report')!;
    expect(first.data).toMatchObject({ chapter: 1, reds: ['命中禁词「顿时」'] })
    const attempt = evs.find((e) => e.type === 'retry/attempt')!;
    expect(attempt.data).toMatchObject({ attempt: 0, maxAttempts: 3 });
    const attemptData = attempt.data as { redIssues?: string[] };
    expect(attemptData.redIssues).toEqual(['命中禁词「顿时」'])
  } finally {
    rmSync(ud, { recursive: true, force: true })
  }
})

test('触顶 escalate：多次红 → retry/attempt 记录每轮 + 最终 escalate 不落 retry/attempt 之外的 pass', async () => {
  const workDir = makeDualTrackWorkdir()
  const bookRoot = join(workDir, '短篇', SHORT_BOOK)
  const ud = mkdtempSync(join(tmpdir(), 'clwriting-sh-chain2-'))
  try {
    const emitted: DriverEvent[] = []
    const opts: SelfHealOpts = {
      driver: makeEmitDriver(emitted),
      mainSession: { id: 'main', cwd: workDir, closed: false },
      userDataPath: ud,
      cwd: workDir,
      bookRoot,
      bookName: BOOK,
      chapter: 1,
      maxAttempts: 2,
      check: () => redOutcome(),
      save: makeSave(),
      genFn: makeGenFn(['一稿', '二稿', '三稿']),
    }
    const r = await runSelfHeal(opts)
    expect(r.outcome).toBe('escalate')

    const evs = readChain(ud, bookRoot)
    const attempts = evs.filter((e) => e.type === 'retry/attempt').map((e) => e.data as { attempt: number })
    // 3 次机检全红：首检打回（attempt 0）+ 重写后打回（attempt 1）→ 触顶 escalate（attempt 2，evaluateRetry 也记）
    expect(attempts.map((a) => a.attempt)).toEqual([0, 1, 2])
    expect(evs.filter((e) => e.type === 'check/report').length).toBe(3)
  } finally {
    rmSync(ud, { recursive: true, force: true })
  }
})

