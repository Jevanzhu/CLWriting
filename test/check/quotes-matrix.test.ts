/**
 * 表驱动引号边界用例矩阵（批次 5，V-P1-6/V-P1-7/V-P2-12/V-P2-13 的边界固化）。
 *
 * 中文两套引号体系（直角「」『』 + 弯“”‘’）在四个消费点的行为契约：
 * quotes.ts 原语 / 对话行识别 / 新专名候选 / 伏笔证据提取。
 * 每个用例一行数据，新增边界优先加表项而非新 describe。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { stripQuotedSpans, QUOTED_SPAN_RE } from '../../src/check/quotes.js'
import { computeStyleMetrics, checkNewNames } from '../../src/check/count.js'
import { extractEvidenceCore } from '../../src/check/leads.js'
import type { IronRules } from '../../src/format/iron-rules.js'

const RULES = { maxDialogueTagRatio: 1 } as IronRules

// ── 1. 原语：stripQuotedSpans（双体系 × 多片段 × 未闭合）────────────

describe('引号矩阵 · stripQuotedSpans', () => {
  it.each([
    ['「直角」', ''],
    ['“弯引号”', ''],
    ['『二重直角』', ''],
    ['‘单弯’外', '‘单弯’外'], // ‘’ 不在 SPAN 集（单弯引号多为强调非对白），契约：原样保留
    ['前「一」中“二”后', '前中后'],
    // 嵌套引号按单层切（内层闭引号先终止 span）——文档化现状，非缺陷
    ['「嵌“套”」余', '」余'],
    ['未闭合「残文', '未闭合「残文'],
    ['无引号行', '无引号行'],
    ['「跨『多』层」x「再」', '层」x'],
  ])('%s → %j', (line, expected) => {
    expect(stripQuotedSpans(line)).toBe(expected)
  })

  it('QUOTED_SPAN_RE 跨体系配对是文档化行为（任一开 + 任一闭）', () => {
    expect(QUOTED_SPAN_RE.test('「混搭”')).toBe(true)
  })
})

// ── 2. 对话行识别 + 标签占比（引号外才算标签，V-P1-7）────────────────

describe('引号矩阵 · 对话行与标签', () => {
  it.each([
    ['「直角对白。」', 1],
    ['“弯引号对白。”', 1],
    ['『二重对白』', 1],
    ['他说：「带我走。」', 1], // 引号外提示语 → 计为标签行
    ['叙述句没有引号。', 0],
  ])('%s → 对话行 %i', (line, expected) => {
    expect(computeStyleMetrics(line, RULES)._dialogueLines).toBe(expected)
  })

  it.each([
    ['他说：「住手。」', true], // 外部「说」→ 标签
    ['「你说道试试。」', false], // “说道”在引号内 → 不算标签（V-P1-7 核心）
    ['他却笑道：“来吧。”', true], // 弯引号体系同口径（外部“笑道”）
    ['“问道二字在内。”', false],
  ])('%s → 标签行=%s', (line, expected) => {
    const tagged = /^[\u4e00-\u9fff]{1,8}(说|道|问|喊|叫|答|叹|笑)(了|着)?/u.test(stripQuotedSpans(line)) || /[\u4e00-\u9fff]{1,8}(说|道|问|喊|叫|答|叹|笑)(了|着)?/u.test(stripQuotedSpans(line))
    expect(tagged).toBe(expected)
  })

  it('computeStyleMetrics 整合：对白内的“笑道”不再虚增标签占比', () => {
    const body = '「你笑道什么？」\n“他也笑道。”\n叙述一行。'
    const stats = computeStyleMetrics(body, RULES)
    expect(stats._dialogueLines).toBe(2)
    expect(stats.dialogueTagRatio).toBe(0) // 两行对白内都无外部标签
  })
})

// ── 3. 新专名候选（对白整行豁免 + 句读豁免，V-P2-13）────────────────

describe('引号矩阵 · 新专名候选', () => {
  let roster: string
  beforeAll(() => {
    const d = mkdtempSync(join(tmpdir(), 'quotes-matrix-'))
    roster = join(d, '名册.md')
    writeFileSync(roster, '已登记：萧破军、赵无极', 'utf-8')
  })
  afterAll(() => rmSync(join(roster, '..'), { recursive: true, force: true }))

  const candidatesOf = (body: string): string[] =>
    checkNewNames(body, roster).items.map((i) => i.message.match(/「(.+?)」/)?.[1] ?? '')

  it.each([
    ['“云澈”出手，剑光如虹。', ['云澈']], // 弯引号体系同口径抽名
    ['「云澈」看向「苏若雪」。', ['云澈', '苏若雪']],
    ['他喊道：「住手！」', []], // 提示语整行对白 → 豁免
    ['“快走，别管我。”', []], // 片段含句读 → 对白非专名
    ['「萧破军」出列。', []], // 已登记名册 → 不报
    ['「太长了名字肯定不是专名」', []], // >4 字 → 超长跳过
  ])('%s → %j', (body, expected) => {
    expect(candidatesOf(body).sort()).toEqual([...expected].sort())
  })
})

// ── 4. 伏笔证据提取（双体系 + 直引号 + 兜底，V-P2-12）───────────────

describe('引号矩阵 · extractEvidenceCore', () => {
  it.each([
    ['伏笔「这一剑藏了十年的杀意」尾', '这一剑藏了十年的杀意'],
    ['伏笔“弯引号里的长证据”尾', '弯引号里的长证据'],
    ['伏笔"ascii straight quote evidence"尾', 'ascii straight quote evidence'],
    // Y-22（第五十七轮）：引号内 <5 字走 slice 兜底时先剥首尾引号——带引号 grep 正文
    // 整组 miss（正文写无引号的同文时误报 lead-evidence-miss）
    ['「短」', '短'],
    ['“弯短”', '弯短'],
    ['无引号证据走前八字截断逻辑', '无引号证据走前八'],
  ])('%s → 提取 %j', (evidence, expected) => {
    expect(extractEvidenceCore(evidence)).toBe(expected)
  })
})
