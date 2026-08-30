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
import { makeDualTrackWorkdir, SHORT_BOOK, LONG_BOOK, tempUserData } from '../studio/fixtures.js'
// R27-120/121（二十七轮）：workDir/userDataPath 登记回收——本文件原先 0 个 rmSync，
// 每次全量跑泄漏含 .git 的双书仓库（fixtures.ts 裸 mkdtemp 因 Playwright global-setup
// 复用不能改，per-test 包 trackTempDir）；userDataPath 弃固定共享 '/tmp/clwriting-test'
// 改 tempUserData 唯一目录（fixtures.ts:199 口径）+ 登记清算
import { trackTempDir } from '../helpers/temp-dir.js'
import {
  runSelfHeal,
  isSelfHealRunning,
  abortSelfHeal,
  type SelfHealOpts,
} from '../../src/ai/orchestrate/self-heal.js'
import type { CheckOutcome } from '../../src/studio/server/api/check.js'
import type { DriverEvent, Session, StudioDriver } from '../../src/driver/index.js'
import type { ChapterMeta } from '../../src/format/types.js'
import type { saveDraft } from '../../src/studio/server/api/draft.js'

const BOOK = SHORT_BOOK
const META: ChapterMeta = {
  章号: 1,
  标题: '测试章',
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
  origin?: string
}

function makeSave(calls: SaveCall[]): typeof saveDraft {
  return (bookRoot, _chapter, content, opts) => {
    calls.push({
      content,
      ...(opts?.snapshotOrigin ? { origin: opts.snapshotOrigin } : {}),
    })
    // 草稿直接写正文区（与 saveDraft 真实路径一致）
    const dir = join(bookRoot, '写作', '正文')
    const relPath = '写作/正文/1-测试章.md'
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(bookRoot, relPath), content, 'utf8')
    return { relPath, docId: 'doc-短篇-1', words: content.length, snapshotted: false }
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

const FM = '---\n章号: 1\n标题: 测试章\n---\n'

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
  const workDir = trackTempDir(makeDualTrackWorkdir())
  const bookRoot = join(workDir, '短篇', SHORT_BOOK)
  const emitted: DriverEvent[] = []
  const driver = makeEmitDriver(emitted)
  const { genFn, prompts } = makeGenFn(texts)
  const saves: SaveCall[] = []
  const opts: SelfHealOpts = {
    driver,
    mainSession: { id: 'main', cwd: workDir, closed: false },
    userDataPath: trackTempDir(tempUserData()),
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

test('B2：黄项修复指令（规则违规）拼入重写 prompt', async () => {
  const seq: CheckOutcome[] = [redOutcome('命中禁词「顿时」'), greenOutcome()]
  let i = 0
  const { opts, prompts } = setup(
    [`${FM}初稿值得一提的是`, `${FM}改好的稿`],
    () => seq[i++] ?? greenOutcome(),
  )
  await runSelfHeal(opts)

  expect(prompts).toHaveLength(2)
  // 黄项修复指令（ai-cliche 规则检出「值得一提的是」）出现在重写 prompt 中
  expect(prompts[1]).toContain('AI高频套话')
  expect(prompts[1]).toContain('值得一提的是')
})

test('重写 original 传含 front matter 的草稿全文', async () => {
  const seq: CheckOutcome[] = [redOutcome(), greenOutcome()]
  let i = 0
  const { opts, prompts } = setup([`${FM}初稿正文`, `${FM}二稿`], () => seq[i++] ?? greenOutcome())
  await runSelfHeal(opts)

  expect(prompts[1]).toContain('章号: 1')
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

test('落盘：三段落盘（首稿+中间稿+终稿）；origin 标 self-heal', async () => {
  const seq: CheckOutcome[] = [redOutcome(), greenOutcome()]
  let i = 0
  const { opts, saves } = setup([`${FM}初稿`, `${FM}二稿`], () => seq[i++] ?? greenOutcome())
  await runSelfHeal(opts)

  expect(saves).toHaveLength(3)
  // 终稿内容正确（文风轨迹由 self-heal.ts 显式调用，非 saveDraft 内部）
  expect(saves[2]?.content).toBe(`${FM}二稿`)
  expect(saves.every((s) => s.origin === 'self-heal')).toBe(true)
})

test('落盘：草稿文件内容 = 最后一次产出', async () => {
  const seq: CheckOutcome[] = [redOutcome(), greenOutcome()]
  let i = 0
  const { opts, bookRoot } = setup([`${FM}初稿`, `${FM}终稿正文`], () => seq[i++] ?? greenOutcome())
  await runSelfHeal(opts)

  const draft = join(bookRoot, '写作', '正文', '1-测试章.md')
  expect(existsSync(draft)).toBe(true)
  expect(readFileSync(draft, 'utf8')).toBe(`${FM}终稿正文`)
})

test('fm 不合规（NOT_CHAPTER）当红项回灌，不是直接失败', async () => {
  const seq: CheckOutcome[] = [
    { ok: false, code: 'NOT_CHAPTER', error: '缺 front matter 字段：章号' },
    greenOutcome(),
  ]
  let i = 0
  const { opts, prompts } = setup([`${FM}无fm稿`, `${FM}补好fm`], () => seq[i++] ?? greenOutcome())
  const r = await runSelfHeal(opts)

  expect(r.outcome).toBe('pass')
  expect(prompts).toHaveLength(2)
  expect(prompts[1]).toContain('草稿格式不合规')
  expect(prompts[1]).toContain('章号')
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

// ── P2-3：批量连写 ──────────────────────────────

test('批量：2 章全绿 → 每章 pass，进度事件带 done/total', async () => {
  const { opts, prompts, emitted, saves } = setup(
    [`${FM}第一章正文`, `${FM}第二章正文`],
    () => greenOutcome(),
    { chapters: [1, 2] },
  )
  const r = await runSelfHeal(opts)

  expect(r.outcome).toBe('pass')
  if (r.outcome === 'pass') expect(r.chapter).toBe(2)
  expect(prompts).toHaveLength(2) // 每章一次生成
  expect(saves).toHaveLength(4) // 每章首稿+终稿各 1 次 = 2 章 × 2
  // 进度事件序列
  const types = evTypes(emitted)
  expect(types).toContain('self_heal_batch')
  expect(types).toContain('self_heal_phase')
  const phases = emitted.filter((e) => e.type === 'self_heal_phase')
  expect(phases.some((e) => e.phase === 'chapter_start')).toBe(true)
  expect(phases.some((e) => e.phase === 'chapter_done')).toBe(true)
  // chapter_done 带 done/total
  const done = emitted.find((e) => e.type === 'self_heal_phase' && e.phase === 'chapter_done')
  expect(done && 'done' in done ? done.done : null).toBe(1)
  expect(done && 'total' in done ? done.total : null).toBe(2)
})

test('批量：中途 escalate → 停后续章 + 发 batch_progress', async () => {
  // 章1 绿；章2 恒红（触顶 escalate）
  const seq: CheckOutcome[] = [greenOutcome(), redOutcome('第二章禁词'), redOutcome('第二章禁词'), redOutcome('第二章禁词')]
  let i = 0
  const { opts, prompts, emitted } = setup(
    [`${FM}一章`, `${FM}二章初稿`, `${FM}二章重写1`, `${FM}二章重写2`, `${FM}二章重写3`],
    () => seq[Math.min(i++, seq.length - 1)]!,
    { chapters: [1, 2] },
  )
  const r = await runSelfHeal(opts)

  expect(r.outcome).toBe('escalate')
  if (r.outcome === 'escalate') {
    expect(r.chapter).toBe(2) // 停在第二章
    expect(r.reds).toContain('第二章禁词')
  }
  expect(prompts).toHaveLength(5) // 章1 一次 + 章2 首稿+3 次重写
  const bp = emitted.find((e) => e.type === 'self_heal_batch_progress')
  expect(bp).toBeTruthy()
  expect(bp && 'done' in bp ? bp.done : null).toBe(1) // 已完成 1 章（章1）
  expect(bp && 'total' in bp ? bp.total : null).toBe(2)
  expect(bp && 'stoppedAt' in bp ? bp.stoppedAt : null).toBe(2) // 停在第二章
})

test('批量：chapters 未传 → 单章行为不变（无 batch 事件）', async () => {
  const { opts, emitted } = setup([`${FM}单章`], () => greenOutcome())
  const r = await runSelfHeal(opts)

  expect(r.outcome).toBe('pass')
  const types = evTypes(emitted)
  expect(types).not.toContain('self_heal_batch')
  expect(types).not.toContain('self_heal_batch_progress')
  expect(types).toContain('self_heal_result')
})

test('W-P2-7：mock 驱动全程 → done 事件携带真实累计 usage（不再恒 0）', async () => {
  const prev = process.env['CLWRITING_DRIVER']
  process.env['CLWRITING_DRIVER'] = 'mock'
  try {
    // genFn: undefined 覆盖默认注入 → runGenerate 走 tryMockTool 快路（usage=MOCK_USAGE）
    const { opts, emitted } = setup([`${FM}全绿`], () => greenOutcome(), { genFn: undefined })
    const r = await runSelfHeal(opts)
    expect(r.outcome).toBe('pass')
    const done = emitted.find((e) => e.type === 'done') as { usage?: number } | undefined
    expect(done).toBeDefined()
    // 一次生成 × mock outputTokens 50 → done.usage 应为 50（修复前恒 0，前端 leg 计数缺）
    expect(done?.usage).toBe(50)
  } finally {
    if (prev === undefined) delete process.env['CLWRITING_DRIVER']
    else process.env['CLWRITING_DRIVER'] = prev
  }
})

// ── X-P1-2：账本侧红（lead-declared-not-done）补生成账本推进草稿 ──────────────────────

/** 账本侧红：细纲声明推进但正文未兑现（actual 侧来自 账本推进.md，pass 前不存在 → 首检必红） */
function leadRedOutcome(): CheckOutcome {
  return {
    ok: true,
    report: {
      sections: [
        { name: '账本', items: [{ checkId: 'lead-declared-not-done', level: 'red', message: '悬念-001 细纲声明推进但正文未兑现' }] },
      ],
    },
    hasRed: true,
    chapter: META,
    body: '正文',
  }
}

/** 长篇书 opts（布线 fixture：悬念-001 进行中 + 细纲声明推进）——X-P1-2 用 */
function setupLongBook(
  check: (p: string) => CheckOutcome,
  extra: Partial<SelfHealOpts> = {},
): { opts: SelfHealOpts; emitted: DriverEvent[]; prompts: string[]; bookRoot: string } {
  const workDir = trackTempDir(makeDualTrackWorkdir())
  const bookRoot = join(workDir, '长篇', LONG_BOOK)
  // 细纲声明推进 悬念-001（账本侧红的数据条件；check 为替身，声明仅为口径还原）
  mkdirSync(join(bookRoot, '工作区'), { recursive: true })
  writeFileSync(join(bookRoot, '工作区', '细纲.md'), '---\n章号: 1\n推进: [悬念-001]\n---\n\n本章细纲。', 'utf8')
  const emitted: DriverEvent[] = []
  const { genFn, prompts } = makeGenFn([`${FM}山门外的钟声在雨夜里连响了三下。`])
  const opts: SelfHealOpts = {
    driver: makeEmitDriver(emitted),
    mainSession: { id: 'main', cwd: workDir, closed: false },
    userDataPath: trackTempDir(tempUserData()),
    cwd: workDir,
    bookRoot,
    bookName: LONG_BOOK,
    chapter: 1,
    check,
    save: makeSave([]),
    genFn,
    ...extra,
  }
  return { opts, emitted, prompts, bookRoot }
}

test('X-P1-2：账本侧红 → 补生成账本推进草稿后复查真绿（不重写正文、只补一次）', async () => {
  const prev = process.env['CLWRITING_DRIVER']
  process.env['CLWRITING_DRIVER'] = 'mock' // generateLeadUpdateDraft 走 mock 快路（悬念-001 递进 + 正文原句证据）
  try {
    const seq: CheckOutcome[] = [leadRedOutcome(), greenOutcome()]
    let i = 0
    const { opts, emitted, prompts, bookRoot } = setupLongBook(() =>
      seq[Math.min(i++, seq.length - 1)]!,
    )
    const r = await runSelfHeal(opts)

    // 补生成后复查真绿 → pass，正文零重写（重写修不了账本侧红）
    expect(r.outcome).toBe('pass')
    if (r.outcome === 'pass') expect(r.attempts).toBe(0)
    expect(prompts).toHaveLength(1)
    // 恰好一次 lead_update 阶段事件（leadDraftTried 防重复 AI 调用）
    const leadPhases = emitted.filter((e) => e.type === 'self_heal_phase' && 'phase' in e && e.phase === 'lead_update')
    expect(leadPhases).toHaveLength(1)
    // pass 后不再重复生成（leadDraftTried 抑制 pass 分支的二次调用）
    expect(prompts).toHaveLength(1)
    // 账本推进.md 已落盘：章节标签 + 悬念-001 推进行（mock 文本解析过滤后）
    const draft = readFileSync(join(bookRoot, '工作区', '账本推进.md'), 'utf8')
    expect(draft).toContain('# 第1章 账本推进')
    expect(draft).toContain('- 悬念-001 递进：山门外的钟声在雨夜里连响了三下。')
  } finally {
    if (prev === undefined) delete process.env['CLWRITING_DRIVER']
    else process.env['CLWRITING_DRIVER'] = prev
  }
})

test('X-P1-2：补生成失败（无 provider）→ 不死循环，按正常重写/升级走（只补一次）', async () => {
  const prev = process.env['CLWRITING_DRIVER']
  delete process.env['CLWRITING_DRIVER'] // 真实 provider 路径 → 空 providers 解析失败
  try {
    let i = 0
    const { opts, emitted, prompts, bookRoot } = setupLongBook(() => {
      i++
      return leadRedOutcome() // 恒红（重写修不了账本侧红）→ 触顶升级
    })
    const r = await runSelfHeal(opts)

    expect(r.outcome).toBe('escalate')
    if (r.outcome === 'escalate') expect(r.attempts).toBe(3)
    // 首稿 + 3 次重写；lead_update 只补一次（失败后不再重试生成，交给重写循环）
    expect(prompts).toHaveLength(4)
    const leadPhases = emitted.filter((e) => e.type === 'self_heal_phase' && 'phase' in e && e.phase === 'lead_update')
    expect(leadPhases).toHaveLength(1)
    // 生成失败 → 账本推进.md 未落盘
    expect(existsSync(join(bookRoot, '工作区', '账本推进.md'))).toBe(false)
  } finally {
    if (prev === undefined) delete process.env['CLWRITING_DRIVER']
    else process.env['CLWRITING_DRIVER'] = prev
  }
})

test('GG-F1①（ii 批）：首稿前备料接线——工作区/本章写作材料.md 落盘 + prompt 含备料段', async () => {
  const prev = process.env['CLWRITING_DRIVER']
  process.env['CLWRITING_DRIVER'] = 'mock'
  try {
    const { opts, prompts, bookRoot } = setupLongBook(() => greenOutcome())
    const materialsPath = join(bookRoot, '工作区', '本章写作材料.md')
    expect(existsSync(materialsPath)).toBe(false) // 接线前无人写材料槽
    const r = await runSelfHeal(opts)

    expect(r.outcome).toBe('pass')
    // 备料已落盘（近况/文风等段经 prepareMaterials 组装，长篇 fixture 布线书 db 可用）
    expect(existsSync(materialsPath)).toBe(true)
    const materials = readFileSync(materialsPath, 'utf8')
    expect(materials.length).toBeGreaterThan(0)
    // buildDraftPrompt 读到材料 → 首稿 prompt 注入「备料」段（此前生产链永缺）
    expect(prompts[0]).toContain('## 备料')
  } finally {
    if (prev === undefined) delete process.env['CLWRITING_DRIVER']
    else process.env['CLWRITING_DRIVER'] = prev
  }
})
