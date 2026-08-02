/**
 * 全自动写章 · 红项自愈闭环编排器单测（重构版）。
 *
 * genFn 注入 mock 生成（替代旧 driver spawnRole+stream mock）。
 * driver 仅用于 emit（SSE 进度回流）。
 * 用短篇书 fixture 跳过 rebuild + sqlite，聚焦编排逻辑本身。
 */
import { test, expect } from 'vitest'
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { makeDualTrackWorkdir, SHORT_BOOK } from '../studio/fixtures.js'
import {
  runSelfHeal,
  isSelfHealRunning,
  abortSelfHeal,
  type SelfHealOpts,
} from '../../src/studio/server/api/self-heal.js'
import type { CheckOutcome } from '../../src/studio/server/api/check.js'
import type { DriverEvent, Session, StudioDriver } from '../../src/driver/index.js'
import type { ChapterMeta } from '../../src/format/types.js'
import type { saveDraft } from '../../src/studio/server/api/draft.js'

const BOOK = SHORT_BOOK
const META: ChapterMeta = {
  章号: 1,
  标题: '测试篇',
  钩子类型: '悬念钩',
  钩子强弱: '中',
  情绪定位: '铺垫',
}

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

interface SaveCall {
  content: string
  recordAi: boolean
  origin?: string
}

function makeSave(calls: SaveCall[]): typeof saveDraft {
  return (bookRoot, _chapter, content, opts) => {
    calls.push({
      content,
      recordAi: opts?.recordAi !== false,
      ...(opts?.snapshotOrigin ? { origin: opts.snapshotOrigin } : {}),
    })
    const dir = join(bookRoot, '工作区')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, '草稿-1.md'), content, 'utf8')
    return { relPath: '工作区/草稿-1.md', docId: 'doc-短篇-1', words: content.length, snapshotted: false }
  }
}

/** 最小 driver（仅 emit 用于 SSE 进度回流；stream 不再被 self-heal 调用） */
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

/** mock genFn：每次调用吐一段固定文本，记录 prompt */
function makeGenFn(texts: string[]): { genFn: NonNullable<SelfHealOpts['genFn']>; prompts: string[] } {
  const prompts: string[] = []
  let idx = 0
  const genFn: NonNullable<SelfHealOpts['genFn']> = async (prompt, _kind, _signal, onText) => {
    prompts.push(prompt)
    const t = texts[idx] ?? texts[texts.length - 1] ?? ''
    idx++
    if (onText && t) onText(t)
    return t
  }
  return { genFn, prompts }
}

const FM = '---\n篇号: 1\n标题: 测试篇\n---\n'

interface Setup {
  opts: SelfHealOpts
  emitted: DriverEvent[]
  prompts: string[]
  saves: SaveCall[]
  bookRoot: string
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
  const { genFn, prompts } = makeGenFn(texts)
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
    genFn,
    ...extra,
  }
  return { opts, emitted, prompts, saves, bookRoot }
}

function evTypes(emitted: DriverEvent[]): string[] {
  return emitted.map((e) => e.type)
}

test('一次绿：1 次 check、0 次重写 → pass', async () => {
  let checks = 0
  const { opts, prompts, emitted } = setup([`${FM}全绿正文`], () => {
    checks++
    return greenOutcome()
  })
  const r = await runSelfHeal(opts)

  expect(r.outcome).toBe('pass')
  if (r.outcome === 'pass') expect(r.attempts).toBe(0)
  expect(checks).toBe(1)
  expect(prompts).toHaveLength(1)
  expect(evTypes(emitted)).not.toContain('self_heal_reset')
})

test('先红后绿：1 次重写且 prompt 带红项明细 → pass', async () => {
  const seq: CheckOutcome[] = [redOutcome('命中禁词「顿时」'), greenOutcome()]
  let i = 0
  const { opts, prompts, emitted } = setup([`${FM}初稿`, `${FM}改好的稿`], () => seq[i++] ?? greenOutcome())
  const r = await runSelfHeal(opts)

  expect(r.outcome).toBe('pass')
  if (r.outcome === 'pass') expect(r.attempts).toBe(1)
  expect(prompts).toHaveLength(2)
  expect(prompts[1]).toContain('命中禁词「顿时」')
  expect(prompts[1]).toContain('审稿意见')
  expect(prompts[1]).not.toContain('1. 请修复以下红项后重写')
  expect(evTypes(emitted)).toContain('self_heal_reset')
})

test('重写 original 传含 front matter 的草稿全文', async () => {
  const seq: CheckOutcome[] = [redOutcome(), greenOutcome()]
  let i = 0
  const { opts, prompts } = setup([`${FM}初稿正文`, `${FM}二稿`], () => seq[i++] ?? greenOutcome())
  await runSelfHeal(opts)

  expect(prompts[1]).toContain('篇号: 1')
  expect(prompts[1]).toContain('初稿正文')
})

test('触顶：4 次 check / 3 次重写后仍红 → escalate + reds 非空', async () => {
  let checks = 0
  const { opts, prompts } = setup([`${FM}稿`], () => {
    checks++
    return redOutcome('命中禁词「顿时」')
  })
  const r = await runSelfHeal(opts)

  expect(r.outcome).toBe('escalate')
  if (r.outcome === 'escalate') {
    expect(r.attempts).toBe(3)
    expect(r.reds).toEqual(['命中禁词「顿时」'])
  }
  expect(checks).toBe(4)
  expect(prompts).toHaveLength(4)
})

test('落盘：中间轮 recordAi=false，终局才 true；origin 标 self-heal', async () => {
  const seq: CheckOutcome[] = [redOutcome(), greenOutcome()]
  let i = 0
  const { opts, saves } = setup([`${FM}初稿`, `${FM}二稿`], () => seq[i++] ?? greenOutcome())
  await runSelfHeal(opts)

  expect(saves).toHaveLength(3)
  expect(saves[0]?.recordAi).toBe(false)
  expect(saves[1]?.recordAi).toBe(false)
  expect(saves[2]?.recordAi).toBe(true)
  expect(saves[2]?.content).toBe(`${FM}二稿`)
  expect(saves.every((s) => s.origin === 'self-heal')).toBe(true)
})

test('落盘：草稿文件内容 = 最后一次产出', async () => {
  const seq: CheckOutcome[] = [redOutcome(), greenOutcome()]
  let i = 0
  const { opts, bookRoot } = setup([`${FM}初稿`, `${FM}终稿正文`], () => seq[i++] ?? greenOutcome())
  await runSelfHeal(opts)

  const draft = join(bookRoot, '工作区', '草稿-1.md')
  expect(existsSync(draft)).toBe(true)
  expect(readFileSync(draft, 'utf8')).toBe(`${FM}终稿正文`)
})

test('fm 不合规（NOT_CHAPTER）当红项回灌，不是直接失败', async () => {
  const seq: CheckOutcome[] = [
    { ok: false, code: 'NOT_CHAPTER', error: '缺 front matter 字段：篇号' },
    greenOutcome(),
  ]
  let i = 0
  const { opts, prompts } = setup([`${FM}无fm稿`, `${FM}补好fm`], () => seq[i++] ?? greenOutcome())
  const r = await runSelfHeal(opts)

  expect(r.outcome).toBe('pass')
  expect(prompts).toHaveLength(2)
  expect(prompts[1]).toContain('草稿格式不合规')
  expect(prompts[1]).toContain('篇号')
})

test('机检自身异常（CHECK_ERROR）→ failed，不空转重写', async () => {
  let checks = 0
  const { opts, prompts } = setup([`${FM}稿`], () => {
    checks++
    return { ok: false, code: 'CHECK_ERROR', error: 'sqlite 打不开' }
  })
  const r = await runSelfHeal(opts)

  expect(r.outcome).toBe('failed')
  if (r.outcome === 'failed') expect(r.error).toContain('sqlite')
  expect(checks).toBe(1)
  expect(prompts).toHaveLength(1)
})

test('AI 产出为空 → failed（不落空稿）', async () => {
  const { opts, saves } = setup(['   '], () => greenOutcome())
  const r = await runSelfHeal(opts)

  expect(r.outcome).toBe('failed')
  if (r.outcome === 'failed') expect(r.error).toContain('为空')
  expect(saves).toHaveLength(0)
})

test('并发锁：跑的过程中 isSelfHealRunning=true，结束即释放', async () => {
  let seen: boolean | null = null
  const { opts } = setup([`${FM}稿`], () => {
    seen = isSelfHealRunning(BOOK)
    return greenOutcome()
  })
  await runSelfHeal(opts)

  expect(seen).toBe(true)
  expect(isSelfHealRunning(BOOK)).toBe(false)
})

test('中断：abortSelfHeal 后不再起下一轮重写 → aborted', async () => {
  const { opts, prompts } = setup([`${FM}稿`], () => {
    abortSelfHeal(BOOK)
    return redOutcome()
  })
  const r = await runSelfHeal(opts)

  expect(r.outcome).toBe('aborted')
  expect(prompts).toHaveLength(1)
  expect(isSelfHealRunning(BOOK)).toBe(false)
})

test('终局必发 self_heal_result + done', async () => {
  const { opts, emitted } = setup([`${FM}稿`], () => greenOutcome())
  await runSelfHeal(opts)

  const types = evTypes(emitted)
  expect(types[0]).toBe('role_spawn')
  expect(types).toContain('self_heal_result')
  expect(types[types.length - 1]).toBe('done')
  const result = emitted.find((e) => e.type === 'self_heal_result')
  expect(result && 'outcome' in result ? result.outcome : null).toBe('pass')
})

test('text 事件转发主 session（前端逐字产出）', async () => {
  const { opts, emitted } = setup([`${FM}逐字正文`], () => greenOutcome())
  await runSelfHeal(opts)

  const texts = emitted.filter((e) => e.type === 'text')
  expect(texts).toHaveLength(1)
  expect(texts[0] && 'text' in texts[0] ? texts[0].text : '').toContain('逐字正文')
})
