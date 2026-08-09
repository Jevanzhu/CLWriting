/**
 * 三审执行编排 —— 依据 M4 #20/#22。
 *
 * 脚本与宿主职责分离（运行时零依赖、可确定性测试）：
 * - 脚本侧（本模块）：按 tier 决策把任务书 + 章正文 + 账本清单打包成「执行包」，
 *   供宿主按视角调用真模型；宿主产出的多份 issues JSON 回流后，本模块归一化、
 *   聚合、渲染成作者可裁决的审稿单。
 * - 宿主侧（Claude Code / Codex / 通用）：读执行包 → 调模型 → 回写 issues JSON。
 *
 * 真模型只负责按任务书产 issues；降级判定、证据硬闸、ledger/safety 自动阻断、
 * issue 聚合全部留在脚本层（review/contract.ts），主流程不被口头代替三审。
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { CheckReport } from '../check/types.js'
import {
  aggregateReviewIssues,
  buildReviewTasks,
  normalizeReviewResult,
  selectReviewTier,
  type ReviewHostCapabilities,
  type ReviewIssue,
  type ReviewLens,
  type ReviewResult,
  type ReviewTask,
  type ReviewTier,
  type ReviewTierDecision,
  type NormalizedReviewResult,
  type PieceListCheck,
} from './contract.js'

/** 单视角的执行包：宿主据此调一次模型产出该视角的 issues。 */
export interface ReviewLensPacket {
  lens: ReviewLens
  title: string
  focus: string[]
  /** 设定校对专属：本章账本变动清单（账本清单驱动逐条核对，恒跑不被降级稀释） */
  ledger_checks: ReviewTask['ledger_checks']
  /** 短篇设定收尾审专属：单篇清单核对条目（反转线索表 + 伏笔回收，恒跑） */
  list_checks?: PieceListCheck[]
  /** 输出契约：JSON only / 必带证据 / 不打分 */
  output_contract: ReviewTask['output_contract']
  /** 本章正文（front matter 之后的正文体） */
  body: string
  /** 本章章号 */
  chapter: number
}

/** 三审执行包：一次三审的全部输入 + 各视角分包。 */
export interface ReviewExecutionPacket {
  chapter: number
  /** run 时使用的草稿路径；collect 用它做一致性校验。 */
  draft_path?: string
  /** run 时草稿原始字节 hash；collect 校验防止回收期间草稿漂移。 */
  draft_hash?: string
  tier: ReviewTier
  requested_tier: ReviewTier
  fallback: string
  downgrade_reason?: string
  lenses_run: ReviewLens[]
  /** 预计 AI 调用次数（满审/顺序审=3，合审=1） */
  planned_calls: 1 | 3
  /** 各视角分包（满审/顺序审=3 份独立；合审=1 份合并） */
  packets: ReviewLensPacket[]
  /** 输出目录：宿主把各视角 issues JSON 回写到此处 */
  out_dir: string
}

/** 宿主回写的单视角 issues 文件名（相对 out_dir）。 */
export function lensIssuesFileName(lens: ReviewLens): string {
  return `issues-${lens}.json`
}

/** 宿主回写的合审 issues 文件名（合审档位单文件）。 */
export const COMBINED_ISSUES_FILE = 'issues-combined.json'

/**
 * 组装三审执行包（#20/#22）。
 * 不调模型、只打包输入；宿主读包后按 packets 各调一次模型。
 *
 * @param input.checkReport 机检报告（提供 byproducts.leadChanges → 设定校对账本清单）
 * @param input.body 本章正文
 * @param input.chapter 本章章号
 * @param input.workDir 工作区目录（out_dir = 工作区/三审/）
 * @param input.capabilities 宿主能力（并行 subagent / 多次调用）
 * @param input.remaining_calls 剩余调用预算
 * @param input.high_risk 是否高风险章（禁止降级）
 */
export function buildReviewPacket(input: {
  checkReport: CheckReport
  body: string
  chapter: number
  draft_path?: string
  draft_hash?: string
  workDir: string
  capabilities: ReviewHostCapabilities
  remaining_calls: number
  high_risk: boolean
  /** 有布线（账本/成长线）→ continuity 视角；有 config.short → 短篇三视角 */
  hasWiring: boolean
  hasShort: boolean
}): { ok: true; packet: ReviewExecutionPacket; decision: ReviewTierDecision } | { ok: false; reason: string } {
  const tasks = buildReviewTasks(input.checkReport, { hasWiring: input.hasWiring, hasShort: input.hasShort })
  const lenses = tasks.map((t) => t.lens)
  const decision = selectReviewTier({
    capabilities: input.capabilities,
    remaining_calls: input.remaining_calls,
    high_risk: input.high_risk,
    lenses,
  })
  if (!decision.ok) return { ok: false, reason: decision.reason }

  const outDir = join(input.workDir, '三审')

  // 合审：三视角合并成单个分包（宿主单次调用覆盖三视角）
  const packets: ReviewLensPacket[] =
    decision.tier === 'combined'
      ? [buildCombinedPacket(tasks, input.body, input.chapter)]
      : tasks.map((task) => taskToPacket(task, input.body, input.chapter))

  return {
    ok: true,
    decision,
    packet: {
      chapter: input.chapter,
      ...(input.draft_path ? { draft_path: input.draft_path } : {}),
      ...(input.draft_hash ? { draft_hash: input.draft_hash } : {}),
      tier: decision.tier,
      requested_tier: decision.requested_tier,
      fallback: decision.fallback,
      ...(decision.downgrade_reason ? { downgrade_reason: decision.downgrade_reason } : {}),
      lenses_run: decision.lenses_run,
      planned_calls: decision.calls,
      packets,
      out_dir: outDir,
    },
  }
}

/** 把单视角任务书打包成执行包分项。 */
function taskToPacket(task: ReviewTask, body: string, chapter: number): ReviewLensPacket {
  return {
    lens: task.lens,
    title: task.title,
    focus: task.focus,
    ledger_checks: task.ledger_checks,
    ...(task.list_checks && task.list_checks.length > 0 ? { list_checks: task.list_checks } : {}),
    output_contract: task.output_contract,
    body,
    chapter,
  }
}

/** 合审档位：三视角焦点 + 账本/清单核对合并成单个分包。 */
function buildCombinedPacket(tasks: ReviewTask[], body: string, chapter: number): ReviewLensPacket {
  // 长篇：账本清单恒属设定校对（continuity）；短篇：清单核对恒属设定收尾审（payoff）
  const continuity = tasks.find((t) => t.lens === 'continuity')
  const payoff = tasks.find((t) => t.lens === 'payoff')
  const ledgerChecks = continuity?.ledger_checks ?? []
  const listChecks = payoff?.list_checks ?? []
  // 合审锚定 lens：长篇 continuity（账本核对不丢）/ 短篇 payoff（清单核对不丢）
  const anchor = payoff ?? continuity ?? tasks[0]!
  const focus = ['合审：覆盖三视角'].concat(tasks.flatMap((t) => t.focus.map((f) => `[${t.title}] ${f}`)))
  return {
    lens: anchor.lens,
    title: '三审合审',
    focus,
    ledger_checks: ledgerChecks,
    ...(listChecks.length > 0 ? { list_checks: listChecks } : {}),
    output_contract: tasks[0]!.output_contract,
    body,
    chapter,
  }
}

/**
 * 从 out_dir 回收各视角 issues JSON，归一化成审稿单数据。
 * - 满审/顺序审：读 issues-reader.json / issues-editor.json / issues-continuity.json
 * - 合审：读 issues-combined.json（单文件，issue.lens 字段标属哪个视角）
 *
 * 缺文件、坏 JSON、空 issues 均不崩：缺视角记到 collected_lens、bad_entries 记损坏项。
 */
export interface CollectedReview {
  ok: boolean
  /** 实际回收到的视角 */
  collected_lenses: ReviewLens[]
  /** 期望但缺失的视角 */
  missing_lenses: ReviewLens[]
  /** 损坏文件（路径 + 原因） */
  bad_entries: { path: string; reason: string }[]
  /** 原始 issues（归一化前） */
  raw_issues: ReviewIssue[]
  /** 归一化结果 */
  normalized: NormalizedReviewResult
  /** tier（用于审稿单元信息） */
  tier: ReviewTier
  requested_tier: ReviewTier
  fallback: string
  chapter: number
  lenses_run: ReviewLens[]
}

export function collectReviewIssues(input: {
  packet: ReviewExecutionPacket
}): CollectedReview {
  const expectedFiles: { lens: ReviewLens; file: string }[] =
    input.packet.tier === 'combined'
      ? [{ lens: input.packet.lenses_run[0] ?? 'continuity', file: COMBINED_ISSUES_FILE }]
      : input.packet.lenses_run.map((lens) => ({ lens, file: lensIssuesFileName(lens) }))

  const rawIssues: ReviewIssue[] = []
  const collectedLenses = new Set<ReviewLens>()
  const missingLenses: ReviewLens[] = []
  const badEntries: { path: string; reason: string }[] = []

  for (const expected of expectedFiles) {
    const fp = join(input.packet.out_dir, expected.file)
    if (!existsSync(fp)) {
      // 合审单文件视为三视角全覆盖；独立文件档位逐视角记缺失
      if (input.packet.tier !== 'combined') missingLenses.push(expected.lens)
      continue
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(readFileSync(fp, 'utf-8'))
    } catch {
      badEntries.push({ path: expected.file, reason: 'issues JSON 损坏' })
      continue
    }
    const lensIssues = extractIssues(parsed, expected.lens, badEntries, expected.file)
    // 文件存在即视为该视角已回收（空数组 = 合法的「没问题」结论，不算缺失）
    rawIssues.push(...lensIssues)
    collectedLenses.add(expected.lens)
    // 合审单文件覆盖三视角（长短各三，按 packet.lenses_run 标记）
    if (input.packet.tier === 'combined') {
      for (const l of input.packet.lenses_run) collectedLenses.add(l)
    }
  }

  // 期望视角：独立档按 lenses_run；合审档 lenses_run 已含三视角（长短各三，buildReviewPacket 决定）
  const expectedLenses = input.packet.lenses_run
  for (const lens of expectedLenses) {
    if (!collectedLenses.has(lens) && !missingLenses.includes(lens)) {
      missingLenses.push(lens)
    }
  }

  const result: ReviewResult = {
    issues: rawIssues,
    summary: '',
    meta: {
      requested_tier: input.packet.requested_tier,
      effective_tier: input.packet.tier,
      fallback: input.packet.fallback,
      lenses_run: input.packet.lenses_run,
      ledger_check: '已跑',
    },
  }
  const normalized = normalizeReviewResult(result)

  return {
    // 缺视角 / 损坏 → 审稿单不成立（作者需补跑或确认降级）
    ok: missingLenses.length === 0 && badEntries.length === 0,
    collected_lenses: [...collectedLenses],
    missing_lenses: missingLenses,
    bad_entries: badEntries,
    raw_issues: rawIssues,
    normalized,
    tier: input.packet.tier,
    requested_tier: input.packet.requested_tier,
    fallback: input.packet.fallback,
    chapter: input.packet.chapter,
    lenses_run: input.packet.lenses_run,
  }
}

/** 从解析后的 JSON 提取 issues（数组或 {issues:[...]}）。逐条校验字段、坏项入 bad_entries。 */
function extractIssues(
  parsed: unknown,
  lens: ReviewLens,
  badEntries: { path: string; reason: string }[],
  file: string,
): ReviewIssue[] {
  const arr = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === 'object' && Array.isArray((parsed as { issues?: unknown }).issues)
      ? (parsed as { issues: unknown[] }).issues
      : null
  if (arr === null) {
    badEntries.push({ path: file, reason: 'issues 不是数组也不是 {issues:[...]}' })
    return []
  }
  const out: ReviewIssue[] = []
  for (const item of arr) {
    const issue = coerceIssue(item, lens)
    if (issue === null) {
      badEntries.push({ path: file, reason: `issue 格式不符：${JSON.stringify(item).slice(0, 80)}` })
      continue
    }
    out.push(issue)
  }
  return out
}

/** 把宿主回写的松散对象强类型化为 ReviewIssue；缺关键字段返回 null。 */
function coerceIssue(raw: unknown, fallbackLens: ReviewLens): ReviewIssue | null {
  if (typeof raw !== 'object' || raw === null) return null
  const o = raw as Record<string, unknown>
  const severity = String(o['severity'] ?? '')
  const category = String(o['category'] ?? '')
  if (!isReviewSeverity(severity) || !isReviewCategory(category)) return null
  const location = String(o['location'] ?? '').trim()
  const evidence = Array.isArray(o['evidence'])
    ? (o['evidence'] as unknown[]).map((e) => String(e))
    : typeof o['evidence'] === 'string' ? [String(o['evidence'])] : []
  const lensRaw = String(o['lens'] ?? fallbackLens)
  const lens: ReviewLens = isReviewLens(lensRaw) ? lensRaw : fallbackLens
  return {
    lens,
    severity,
    category,
    location,
    evidence,
    issue: String(o['issue'] ?? ''),
    fix: String(o['fix'] ?? ''),
    ...(o['blocking'] === true ? { blocking: true } : {}),
  }
}

const SEVERITIES: ReadonlySet<string> = new Set(['S1', 'S2', 'S3', 'S4'])
function isReviewSeverity(s: string): s is ReviewIssue['severity'] {
  return SEVERITIES.has(s)
}

const CATEGORIES: ReadonlySet<string> = new Set([
  'high_point', 'reader_pull', 'pacing', 'ooc', 'logic', 'consistency',
  'continuity', 'setting', 'timeline', 'strand', 'ledger', 'safety',
  // 短篇单篇爆破力维（M8 #28 第 4 节）
  'hook', 'emotion_peak', 'reversal', 'payoff',
])
function isReviewCategory(c: string): c is ReviewIssue['category'] {
  return CATEGORIES.has(c)
}

const LENSES: ReadonlySet<string> = new Set([
  'reader', 'editor', 'continuity',
  // 短篇三视角（M8 #28 第 2 节）
  'hook', 'emotion_peak', 'payoff',
])
function isReviewLens(l: string): l is ReviewLens {
  return LENSES.has(l)
}

export { aggregateReviewIssues }
