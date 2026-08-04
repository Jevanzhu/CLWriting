/**
 * W1 验收用例（计划 §六）—— 端到端：对一篇故意带 AI 味的稿子，
 * 系统能检出（黄）、给出人话修复指令、重写后 7 维距离收窄——全程无人工判定。
 *
 * 两层验证：
 * 1. 编排链路（self-heal 真实跑）：初稿带 AI 味 → 机检出黄 → 重写 prompt
 *    拼入带证据的修复指令 → 二稿收敛 → 全绿 pass。
 *    genFn mock 产出初稿/二稿（重写动作本身 mock），check mock 控制红/绿触发；
 *    黄项来自真实规则（collectRuleViolations 在 self-heal 内真实调用）。
 * 2. 规则收敛（纯规则层）：同一稿子真实算指纹——初稿相对基线的 7 维偏离维度数
 *    > 二稿；AI 套话黄项数 初稿 > 二稿（二稿清零）。
 *
 * 基线 = 无 AI 味二稿的真实指纹（写 文风/基线.json），铁律含 单句上限/叠词上限。
 */
import { test, expect } from 'vitest'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { makeDualTrackWorkdir, SHORT_BOOK } from '../studio/fixtures.js'
import {
  runSelfHeal,
  type SelfHealOpts,
} from '../../src/ai/orchestrate/self-heal.js'
import type { CheckOutcome } from '../../src/studio/server/api/check.js'
import type { DriverEvent, Session, StudioDriver } from '../../src/driver/index.js'
import type { ChapterMeta } from '../../src/format/types.js'
import type { saveDraft } from '../../src/studio/server/api/draft.js'
import { collectRuleViolations } from '../../src/ai/rules/index.js'
import { computeFullStats, readIronRules, type FullStyleStats } from '../../src/metrics/style.js'

// ── 故意带 AI 味的稿子（套话 + 超长句 + 形容词堆叠 + 句长方差大） ─────────
const AI_TEXT = `第一段。值得一提的是，他推开门，映入眼帘的是一间昏暗的屋子。他不禁打了个寒颤，一股寒意爬上脊背，仿佛有什么东西在暗处窥视着他，那目光冰冷而锐利，像是要把他的灵魂连同身体一起从血肉中剥离出来，然后咀嚼咽下，再无痕迹。

他缓缓抬起手，缓缓握紧拳头，缓缓吸了一口气。屋子里充满了潮湿的、阴冷的、陈旧的空气。天。

他走出门，门在身后关上，发出沉闷的声响，那声响在走廊里回荡，回荡，再回荡，久久不肯散去，像是某种古老而陌生的咒语，又像是命运在暗中敲响的钟声，一下，又一下，敲在他心口上。`

// ── 修掉 AI 味的二稿（套话清除、句式拉平、形容词精简） ─────────────────────
const CLEAN_TEXT = `他推开门，屋里昏暗。一股寒意爬上脊背，暗处有什么在看他。

他抬手，握拳，吸气。三秒。

他走出门，门在身后关上，发出沉闷的声响，在走廊里回荡，久久不肯散去。`

const FM = '---\n篇号: 1\n标题: 测试篇\n---\n'
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

/** 造书 fixture：短篇书 + 写 文风/基线.json（无 AI 味指纹）+ 铁律（含单句/叠词上限） */
function makeBook(): string {
  const workDir = makeDualTrackWorkdir()
  const bookRoot = join(workDir, '短篇', BOOK)
  const baseline: FullStyleStats = {
    overlongRatio: 0,
    adjStackHits: 0,
    dialogueTagRatio: 0,
    parallelStreakMax: 0,
    summaryEnding: false,
    _dialogueLines: 0,
    sentenceLenVariance: 112.8,
    repeatRate: 0,
  }
  mkdirSync(join(bookRoot, '文风'), { recursive: true })
  writeFileSync(
    join(bookRoot, '文风', '基线.json'),
    JSON.stringify({ version: 1, frozenAt: '2026-01-01T00:00:00.000Z', frozenFrom: 'w1-fixture', byScene: {}, overall: baseline }, null, 2),
    'utf-8',
  )
  writeFileSync(
    join(bookRoot, '文风', '文风铁律.md'),
    '# 文风铁律\n- 正文纯文本\n- 单句上限字数：40\n- 形容词连续堆叠上限：2\n',
    'utf-8',
  )
  return bookRoot
}

interface SaveCall {
  content: string
  recordAi: boolean
}
function makeSave(calls: SaveCall[]): typeof saveDraft {
  return (root, _chapter, content, opts) => {
    calls.push({ content, recordAi: opts?.recordAi !== false })
    const dir = join(root, '工作区')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, '草稿-1.md'), content, 'utf-8')
    return { relPath: '工作区/草稿-1.md', docId: 'doc-短篇-1', words: content.length, snapshotted: false }
  }
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

test('W1 端到端：AI 味稿检出黄 → 修复指令 → 二稿收敛 → pass', async () => {
  const bookRoot = makeBook()
  const emitted: DriverEvent[] = []
  const { genFn, prompts } = makeGenFn([`${FM}${AI_TEXT}`, `${FM}${CLEAN_TEXT}`])
  const saves: SaveCall[] = []
  let checkIdx = 0
  const opts: SelfHealOpts = {
    driver: makeEmitDriver(emitted),
    mainSession: { id: 'main', cwd: bookRoot, closed: false },
    userDataPath: '/tmp/clwriting-test',
    cwd: bookRoot,
    bookRoot,
    bookName: BOOK,
    chapter: 1,
    check: () => (checkIdx++ === 0 ? redOutcome() : greenOutcome()),
    save: makeSave(saves),
    genFn,
  }

  const r = await runSelfHeal(opts)

  // 全绿收工（1 轮重写）
  expect(r.outcome).toBe('pass')
  if (r.outcome === 'pass') expect(r.attempts).toBe(1)

  // ① 检出黄：重写 prompt 含 AI 套话修复指令（带证据词）
  expect(prompts[1]).toContain('AI高频套话')
  expect(prompts[1]).toContain('值得一提')
  // ② 检出黄：重写 prompt 含 7 维风格偏离修复指令（带证据/建议）
  expect(prompts[1]).toContain('偏离基线')
  expect(prompts[1]).toContain('句长方差')
  expect(prompts[1]).toContain('建议拆分')
  // ③ 红黄项优先级区分：红项 [必须]、黄项 [建议]
  expect(prompts[1]).toMatch(/\[必须\]/)
  expect(prompts[1]).toMatch(/\[建议\]/)
  // ④ 第二稿（终稿）落盘 recordAi（文风轨迹留底）
  expect(saves[saves.length - 1]!.recordAi).toBe(true)
  // ⑤ 终局黄项复查：二稿收敛 → yellows 空（系统验证「收窄」，非 mock 保证）
  if (r.outcome === 'pass') expect(r.yellows).toEqual([])
})

test('W1 规则收敛：初稿 3 维偏离 → 二稿 0 维（7 维距离收窄）', () => {
  const bookRoot = makeBook()
  const rules = readIronRules(bookRoot)
  const baseline = { overlongRatio: 0, adjStackHits: 0, dialogueTagRatio: 0, parallelStreakMax: 0, summaryEnding: false, sentenceLenVariance: 112.8, repeatRate: 0 }

  const aiStats = computeFullStats(AI_TEXT, rules)
  const cleanStats = computeFullStats(CLEAN_TEXT, rules)

  // 相对基线偏离度 >40% 的维度数（ai 味稿 3 维，二稿 0 维）
  const devDims = (s: FullStyleStats): number => {
    let n = 0
    if (dev(s.overlongRatio, baseline.overlongRatio)) n++
    if (dev(s.adjStackHits, baseline.adjStackHits)) n++
    if (dev(s.sentenceLenVariance, baseline.sentenceLenVariance)) n++
    if (dev(s.repeatRate, baseline.repeatRate)) n++
    if (dev(s.dialogueTagRatio, baseline.dialogueTagRatio)) n++
    if (dev(s.parallelStreakMax, baseline.parallelStreakMax)) n++
    return n
  }
  expect(devDims(aiStats)).toBeGreaterThan(devDims(cleanStats))
  expect(devDims(cleanStats)).toBe(0)

  // 规则黄项：初稿命中（套话 + 风格），二稿清零
  const aiViolations = collectRuleViolations(AI_TEXT, 'self-heal', bookRoot, 1)
  const cleanViolations = collectRuleViolations(CLEAN_TEXT, 'self-heal', bookRoot, 1)
  expect(aiViolations.filter((v) => v.ruleId === 'ai-cliche').length).toBeGreaterThan(0)
  expect(aiViolations.filter((v) => v.ruleId === 'style-consistency').length).toBeGreaterThan(0)
  expect(cleanViolations).toEqual([])
})

function dev(cur: number, ref: number): boolean {
  if (ref === 0) return cur > 0
  return Math.abs(cur - ref) / Math.abs(ref) > 0.4
}