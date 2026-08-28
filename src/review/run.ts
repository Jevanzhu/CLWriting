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
import { createHash } from 'node:crypto'
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
  type ReviewMeta,
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
  planned_calls: number
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
  /** R62-34：审稿单 meta（ledger_check 等）——normalizeReviewResult 不透传 meta，
   *  此前 ReviewResult.meta 写完即弃（信封/UI 均不可见），随 collected 一并透出 */
  meta: ReviewMeta
  /** tier（用于审稿单元信息） */
  tier: ReviewTier
  requested_tier: ReviewTier
  fallback: string
  chapter: number
  lenses_run: ReviewLens[]
}

/** R63-4（十一轮）：审稿单不成立时的注入 issue——失败路径（stale/缺视角/坏条目）
 *  原先空 issues 过 normalizeReviewResult 得 passed:true（空判据），端点把信封照落、
 *  前端把「采集失败」渲染成「三审通过」——作者按假通过放行从未真正审校的内容。
 *  注入阻断级 issue：normalized.passed 恒 false 且阻断列表可见（evidence 带具体原因）；
 *  ok/bad_entries 信封字段照旧，消费方可双口径核验。 */
function incompleteReviewIssue(reasons: string[], lens: ReviewLens): ReviewIssue {
  return {
    lens,
    severity: 'S2',
    category: 'consistency',
    location: '',
    evidence: reasons,
    issue: '三审未完成：审稿单不成立，本次「通过」不可采信',
    fix: '解决失败原因后重跑三审（原因见证据栏）',
    blocking: true,
  }
}

export function collectReviewIssues(input: {
  packet: ReviewExecutionPacket
}): CollectedReview {
  // R61-13（第六十一轮）：draft_hash 一致性实装——字段自第五轮声明并随包透传，但
  // collect 从不校验（死字段）：回收期间草稿漂移（作者回改正文）会让 issues 指向
  // 已不存在的文本。hash 不符/不可读 → 审稿单不成立（同缺视角/坏条目口径）。
  // R62-34：ledger_check 如实——任一分包带账本核对项才算「已跑」（无布线/账本无变动
  // 时任务书不带 ledger_checks，此前恒报「已跑」与实际执行面不符）
  const ledgerCheckRan = input.packet.packets.some((p) => (p.ledger_checks?.length ?? 0) > 0)
  if (input.packet.draft_path !== undefined && input.packet.draft_hash !== undefined) {
    let actual: string | null = null
    try {
      actual = createHash('sha256').update(readFileSync(input.packet.draft_path)).digest('hex')
    } catch {
      actual = null // 读失败（草稿被删/移动）与 hash 不符同判
    }
    if (actual !== input.packet.draft_hash) {
      const stale: ReviewResult = {
        // R63-4：注入阻断级 issue（原空 issues → 空判据假 passed:true，见 incompleteReviewIssue 头注）
        issues: [
          incompleteReviewIssue(
            ['草稿在审阅期间已变更或不可读（draft_hash 不符），审稿单不成立'],
            input.packet.lenses_run[0] ?? 'continuity',
          ),
        ],
        summary: '',
        meta: {
          requested_tier: input.packet.requested_tier,
          effective_tier: input.packet.tier,
          fallback: input.packet.fallback,
          lenses_run: input.packet.lenses_run,
          ledger_check: ledgerCheckRan ? '已跑' : '跳过',
        },
      }
      return {
        ok: false,
        collected_lenses: [],
        missing_lenses: [],
        bad_entries: [
          {
            path: input.packet.draft_path,
            reason: '草稿在审阅期间已变更或不可读（draft_hash 不符），审稿单不成立，请重跑三审',
          },
        ],
        raw_issues: [],
        normalized: normalizeReviewResult(stale),
        meta: stale.meta,
        tier: input.packet.tier,
        requested_tier: input.packet.requested_tier,
        fallback: input.packet.fallback,
        chapter: input.packet.chapter,
        lenses_run: input.packet.lenses_run,
      }
    }
  }

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
    let text: string
    try {
      text = readFileSync(fp, 'utf-8')
    } catch (e) {
      // RB-KN-P2-8：读取失败与解析失败分类——并发删除/权限错误原先也被记成「JSON 损坏」
      badEntries.push({
        path: expected.file,
        reason: `issues 文件读取失败：${e instanceof Error ? e.message : String(e)}`,
      })
      continue
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
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
  // R73-26（二十一轮·登记裁定）：合审档「单文件存在即记全部视角已回收」的最小覆盖闸
  // ——经核实**本批不可落**：生产链 submit_issues 工具 schema（src/ai/contract/review.ts，
  // B 域禁改范围）没有 lens 字段、审稿 prompt（resources/prompts/review-*.md）也不要求
  // 视角标记，合审 issues 的 lens 全部由 coerceIssue 回落锚视角（lenses_run[0]）——
  // 「按档内视角标记判覆盖」在生产链上恒不满足，强推会把**每一份有发现的合审**判成
  // 「审稿单不成立」（部分回收），且无标记时无从判「视角没跑」与「视角没问题」（输出
  // 契约是「只报问题，无问题回空数组」）。维持现状（文件存在且解析成功 = 回收）；
  // 解锁条件：submit_issues schema 增加 lens 字段（且要求逐视角标记）后，再按档内标记
  // 判覆盖、不足显式标注部分回收。空数组 = 合法「没问题」结论，不算缺失（既有口径）。
  const expectedLenses = input.packet.lenses_run
  for (const lens of expectedLenses) {
    if (!collectedLenses.has(lens) && !missingLenses.includes(lens)) {
      missingLenses.push(lens)
    }
  }

  // R63-4：缺视角/坏条目 → 审稿单不成立——normalized 空判据会假 passed:true，
  // 注入阻断级 issue（见 incompleteReviewIssue 头注）；raw_issues 保持宿主原产不动
  const ok = missingLenses.length === 0 && badEntries.length === 0
  const incompleteReasons: string[] = []
  if (missingLenses.length > 0) incompleteReasons.push(`缺视角：${missingLenses.join('、')}`)
  if (badEntries.length > 0) incompleteReasons.push(...badEntries.map((b) => `损坏：${b.path}（${b.reason}）`))

  const result: ReviewResult = {
    issues: ok ? rawIssues : [...rawIssues, incompleteReviewIssue(incompleteReasons, input.packet.lenses_run[0] ?? 'continuity')],
    summary: '',
    meta: {
      requested_tier: input.packet.requested_tier,
      effective_tier: input.packet.tier,
      fallback: input.packet.fallback,
      lenses_run: input.packet.lenses_run,
      ledger_check: ledgerCheckRan ? '已跑' : '跳过', // R62-34：如实（见函数首注释）
    },
  }
  const normalized = normalizeReviewResult(result)

  return {
    // 缺视角 / 损坏 → 审稿单不成立（作者需补跑或确认降级）
    ok,
    collected_lenses: [...collectedLenses],
    missing_lenses: missingLenses,
    bad_entries: badEntries,
    raw_issues: rawIssues,
    normalized,
    meta: result.meta,
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
  // R65-18（十三轮）：evidence 数组项仅接受 string/number（按原语义 String() 收敛）——
  // 宿主回写 evidence:[{}] 时 String({}) 得非空 "[object Object]"，对象壳穿透
  // 「空 evidence 的 issue 不成立」硬闸；含其他类型项 → 整条判格式不符走 bad_entries
  let evidence: string[]
  if (Array.isArray(o['evidence'])) {
    for (const e of o['evidence'] as unknown[]) {
      if (typeof e !== 'string' && typeof e !== 'number') return null
    }
    evidence = (o['evidence'] as unknown[]).map((e) => String(e))
  } else if (typeof o['evidence'] === 'string') {
    evidence = [String(o['evidence'])]
  } else {
    evidence = []
  }
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
