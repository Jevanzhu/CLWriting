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

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
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
} from './contract.js'

/** 单视角的执行包：宿主据此调一次模型产出该视角的 issues。 */
export interface ReviewLensPacket {
  lens: ReviewLens
  title: string
  focus: string[]
  /** 设定校对专属：本章账本变动清单（账本清单驱动逐条核对，恒跑不被降级稀释） */
  ledger_checks: ReviewTask['ledger_checks']
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

/** review run 落盘的执行包文件名。collect 必须读它，不重算档位。 */
export const REVIEW_PACKET_FILE = 'packet.json'

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
}): { ok: true; packet: ReviewExecutionPacket; decision: ReviewTierDecision } | { ok: false; reason: string } {
  const decision = selectReviewTier({
    capabilities: input.capabilities,
    remaining_calls: input.remaining_calls,
    high_risk: input.high_risk,
  })
  if (!decision.ok) return { ok: false, reason: decision.reason }

  const tasks = buildReviewTasks(input.checkReport)
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

/** 把三审执行包写到 `工作区/三审/packet.json`，供 collect 固定读取。 */
export function writeReviewPacket(packet: ReviewExecutionPacket): string {
  mkdirSync(packet.out_dir, { recursive: true })
  const path = join(packet.out_dir, REVIEW_PACKET_FILE)
  writeFileSync(path, JSON.stringify(packet, null, 2), 'utf-8')
  return path
}

/** 从工作区读取 review run 当时的执行包。 */
export function readReviewPacket(workDir: string): { ok: true; packet: ReviewExecutionPacket; path: string } | { ok: false; reason: string } {
  const path = join(workDir, '三审', REVIEW_PACKET_FILE)
  if (!existsSync(path)) {
    return { ok: false, reason: `找不到三审执行包：${path}。先运行 clwriting review run。` }
  }
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(path, 'utf-8'))
  } catch {
    return { ok: false, reason: `三审执行包损坏：${path}` }
  }
  const packet = coerceReviewPacket(raw)
  if (!packet.ok) return { ok: false, reason: `三审执行包格式不对：${packet.reason}` }
  return { ok: true, packet: packet.packet, path }
}

/** 把单视角任务书打包成执行包分项。 */
function taskToPacket(task: ReviewTask, body: string, chapter: number): ReviewLensPacket {
  return {
    lens: task.lens,
    title: task.title,
    focus: task.focus,
    ledger_checks: task.ledger_checks,
    output_contract: task.output_contract,
    body,
    chapter,
  }
}

/** 合审档位：三视角焦点 + 账本清单合并成单个分包。 */
function buildCombinedPacket(tasks: ReviewTask[], body: string, chapter: number): ReviewLensPacket {
  // 账本清单恒属设定校对（continuity），合审也必须带
  const continuity = tasks.find((t) => t.lens === 'continuity')
  const ledgerChecks = continuity?.ledger_checks ?? []
  const focus = ['合审：覆盖三视角'].concat(tasks.flatMap((t) => t.focus.map((f) => `[${t.title}] ${f}`)))
  return {
    lens: 'continuity', // 合审单包以 continuity 为锚（账本核对不丢）
    title: '三审合审',
    focus,
    ledger_checks: ledgerChecks,
    output_contract: tasks[0]!.output_contract,
    body,
    chapter,
  }
}

/**
 * 渲染执行包为人话指令（给宿主 / 作者看：现在要按什么跑三审）。
 * 真模型调用由宿主据此执行；脚本不内联模型调用。
 */
export function formatReviewPacket(packet: ReviewExecutionPacket): string {
  const lines: string[] = []
  lines.push(`# 三审执行包 · 第 ${packet.chapter} 章`)
  lines.push('')
  lines.push(`- 档位：${tierLabel(packet.tier)}（请求 ${tierLabel(packet.requested_tier)}）`)
  lines.push(`- 预计调用：${packet.planned_calls} 次`)
  if (packet.downgrade_reason) lines.push(`- 降级说明：${packet.downgrade_reason}`)
  lines.push(`- 视角：${packet.lenses_run.map(lensLabel).join(' / ')}`)
  lines.push(`- issues 回写目录：${packet.out_dir}`)
  lines.push('')
  lines.push('## 各视角分包')
  lines.push('')
  for (const p of packet.packets) {
    lines.push(`### ${lensLabel(p.lens)}（${p.title}）`)
    lines.push(`- 焦点：${p.focus.join(' / ')}`)
    if (p.ledger_checks.length > 0) {
      lines.push('- 账本核对（设定校对恒跑，逐条核对）：')
      for (const c of p.ledger_checks) {
        lines.push(`  - ${c.lead_id} 第${c.chapter}章 ${c.verb}：${c.evidence}`)
      }
    } else {
      lines.push('- 账本核对：本视角无账本清单（账本核对专属设定校对）。')
    }
    const issueFile = packet.tier === 'combined' ? COMBINED_ISSUES_FILE : lensIssuesFileName(p.lens)
    lines.push(`- 输出契约：JSON only / 必带 evidence / 不打分；回写 ${issueFile}`)
    lines.push('')
  }
  lines.push('宿主按上述分包各调一次模型，把 issues JSON 回写到 issues 回写目录后，运行 `clwriting review collect` 归一化生成审稿单。')
  return lines.join('\n')
}

// ── issues 回收 + 归一化 + 审稿单 ────────────────────────

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
}

export function collectReviewIssues(input: {
  packet: ReviewExecutionPacket
}): CollectedReview {
  const expectedFiles: { lens: ReviewLens; file: string }[] =
    input.packet.tier === 'combined'
      ? [{ lens: 'continuity', file: COMBINED_ISSUES_FILE }]
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
    // 合审单文件覆盖三视角
    if (input.packet.tier === 'combined') {
      collectedLenses.add('reader')
      collectedLenses.add('editor')
    }
  }

  // 合审：期望三视角都回收（单文件覆盖）；独立档位：按 lenses_run 校
  const expectedLenses = input.packet.tier === 'combined'
    ? (['reader', 'editor', 'continuity'] as ReviewLens[])
    : input.packet.lenses_run
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

// ── 审稿单（工作区/审稿.md）────────────────────────

/** 审稿单里作者裁决标记：作者拍板后写这一行，finalize 读它放行定稿。 */
export const REVIEW_VERDICT_MARKER = '<!-- verdict: approved -->'

/**
 * 渲染归一化结果为作者可裁决的审稿单（工作区/审稿.md）。
 * - blockers / warnings / 无效 issue 三栏分明
 * - 账本核对专列（设定校对产出的 ledger 类，单独置顶突出）
 * - 结尾留作者裁决区：作者写一行 `verdict: 通过` 拍板，finalize 据此放行
 *
 * @param input.pending 是否待作者拍板（true=审稿单未裁决，false=已带裁决标记）
 */
export function renderReviewVerdict(collected: CollectedReview): string {
  const lines: string[] = []
  const { normalized } = collected
  lines.push(`# 审稿单 · 第 ${collected.chapter} 章`)
  lines.push('')
  lines.push(`- 档位：${tierLabel(collected.tier)}（请求 ${tierLabel(collected.requested_tier)}，fallback：${collected.fallback}）`)
  lines.push(`- 视角：${collected.collected_lenses.map(lensLabel).join(' / ')}`)
  if (collected.missing_lenses.length > 0) {
    lines.push(`- ⚠ 缺失视角：${collected.missing_lenses.map(lensLabel).join(' / ')}（需补跑或确认降级）`)
  }
  if (collected.bad_entries.length > 0) {
    lines.push(`- ⚠ 损坏回收：${collected.bad_entries.map((b) => b.path).join(', ')}`)
  }
  lines.push('')

  // 账本核对专列（ledger 类 issue 单独突出，呼应「账本造假被设定校对逮住」出口验收）
  const ledgerBlockers = normalized.blockers.filter((i) => i.category === 'ledger')
  if (ledgerBlockers.length > 0) {
    lines.push('## ⚠ 账本核对阻断（设定校对）')
    lines.push('')
    for (const i of ledgerBlockers) {
      lines.push(`- [${i.severity}] ${i.location}：${i.issue}`)
      lines.push(`  - 证据：${i.evidence.join('；') || '（无）'}`)
      lines.push(`  - 建议：${i.fix || '（无）'}`)
    }
    lines.push('')
  }

  lines.push('## 阻断项（blockers）')
  lines.push('')
  const otherBlockers = normalized.blockers.filter((i) => i.category !== 'ledger')
  if (otherBlockers.length === 0 && ledgerBlockers.length === 0) {
    lines.push('（无）')
  } else if (otherBlockers.length === 0) {
    lines.push('（除账本阻断外无其他阻断项）')
  } else {
    for (const i of otherBlockers) {
      lines.push(`- [${i.severity}] ${lensLabel(i.lens)} · ${i.location}：${i.issue}`)
      lines.push(`  - 证据：${i.evidence.join('；') || '（无）'}`)
      lines.push(`  - 建议：${i.fix || '（无）'}`)
    }
  }
  lines.push('')

  lines.push('## 警告项（warnings）')
  lines.push('')
  if (normalized.warnings.length === 0) {
    lines.push('（无）')
  } else {
    for (const i of normalized.warnings) {
      lines.push(`- [${i.severity}] ${lensLabel(i.lens)} · ${i.location}：${i.issue}`)
      lines.push(`  - 建议：${i.fix || '（无）'}`)
    }
  }
  lines.push('')

  if (normalized.invalid_issues.length > 0) {
    lines.push('## 无效 issue（缺证据，审稿单不成立）')
    lines.push('')
    lines.push('以下 issue 缺少证据，按证据硬闸判无效；需补证据后重新提交，否则 finalize 拒绝定稿：')
    for (const i of normalized.invalid_issues) {
      lines.push(`- ${lensLabel(i.lens)} · ${i.location}：${i.issue}`)
    }
    lines.push('')
  }

  // 作者裁决区
  lines.push('## 作者裁决')
  lines.push('')
  lines.push('在下面「裁决区」精确照抄一行（删掉尖括号占位，保留 HTML 注释标记）：')
  lines.push('')
  lines.push('### 裁决区')
  lines.push('')
  lines.push('```')
  if (normalized.passed && collected.ok) {
    lines.push(`${REVIEW_VERDICT_MARKER} verdict: <把「通过」填这里>`)
  } else {
    lines.push(`${REVIEW_VERDICT_MARKER} verdict: <把「通过」填这里>`)
    lines.push(`${REVIEW_VERDICT_MARKER} override: <放行理由，作者自负>`)
  }
  lines.push('```')
  return lines.join('\n') + '\n'
}

/**
 * 写审稿单到工作区/审稿.md。
 * 注意：默认不带裁决标记——作者必须显式拍板，finalize 才放行。
 */
export function writeReviewVerdict(workDir: string, collected: CollectedReview): string {
  const path = join(workDir, '审稿.md')
  const text = renderReviewVerdict(collected)
  writeFileSync(path, text, 'utf-8')
  return path
}

/** 读审稿单作者裁决（finalize 前置闸用）。无文件 / 无裁决标记 = 未拍板。
 *  裁决标记必须是精确的 `${REVIEW_VERDICT_MARKER} verdict: 通过`，避免误命中
 *  审稿单模板里的示例文本。 */
export function readReviewVerdict(workDir: string): { approved: boolean; hasOverride: boolean; overrideReason?: string } {
  const fp = join(workDir, '审稿.md')
  if (!existsSync(fp)) return { approved: false, hasOverride: false }
  const text = readFileSync(fp, 'utf-8')
  // 只认带 marker 前缀的精确裁决行（不认模板示例里的裸 verdict: 通过）
  const verdictRe = new RegExp(
    `${escapeRegExp(REVIEW_VERDICT_MARKER)}\\s*verdict:\\s*通过\\s*$`,
    'm',
  )
  if (!verdictRe.test(text)) return { approved: false, hasOverride: false }
  const overrideRe = new RegExp(
    `${escapeRegExp(REVIEW_VERDICT_MARKER)}\\s*override:\\s*([^<\\n]+)$`,
    'm',
  )
  // 排除模板占位（含 < 的行），取作者实际写的 override
  const m = text.match(overrideRe)
  const reason = m?.[1]?.trim()
  return { approved: true, hasOverride: reason !== undefined && reason !== '', ...(reason ? { overrideReason: reason } : {}) }
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// ── 辅助 ─────────────────────────────────────────

function coerceReviewPacket(raw: unknown): { ok: true; packet: ReviewExecutionPacket } | { ok: false; reason: string } {
  if (typeof raw !== 'object' || raw === null) return { ok: false, reason: '不是对象' }
  const o = raw as Record<string, unknown>
  const chapter = Number(o['chapter'])
  if (!Number.isSafeInteger(chapter) || chapter < 1) return { ok: false, reason: 'chapter 非正整数' }

  const tier = String(o['tier'] ?? '')
  const requestedTier = String(o['requested_tier'] ?? '')
  if (!isReviewTier(tier) || !isReviewTier(requestedTier)) return { ok: false, reason: 'tier 非法' }

  const fallback = String(o['fallback'] ?? '')
  const plannedCalls = Number(o['planned_calls'])
  if (plannedCalls !== 1 && plannedCalls !== 3) return { ok: false, reason: 'planned_calls 非法' }

  const lensesRaw = o['lenses_run']
  if (!Array.isArray(lensesRaw) || !lensesRaw.every((l) => isReviewLens(String(l)))) {
    return { ok: false, reason: 'lenses_run 非法' }
  }

  const outDir = String(o['out_dir'] ?? '')
  if (outDir === '') return { ok: false, reason: 'out_dir 为空' }

  const packetsRaw = o['packets']
  if (!Array.isArray(packetsRaw)) return { ok: false, reason: 'packets 非数组' }
  const packets: ReviewLensPacket[] = []
  for (const pRaw of packetsRaw) {
    const p = coerceReviewLensPacket(pRaw)
    if (!p.ok) return { ok: false, reason: `packet 分项非法：${p.reason}` }
    packets.push(p.packet)
  }

  return {
    ok: true,
    packet: {
      chapter,
      ...(typeof o['draft_path'] === 'string' ? { draft_path: o['draft_path'] } : {}),
      ...(typeof o['draft_hash'] === 'string' ? { draft_hash: o['draft_hash'] } : {}),
      tier,
      requested_tier: requestedTier,
      fallback,
      ...(typeof o['downgrade_reason'] === 'string' ? { downgrade_reason: o['downgrade_reason'] } : {}),
      lenses_run: lensesRaw.map((l) => String(l) as ReviewLens),
      planned_calls: plannedCalls,
      packets,
      out_dir: outDir,
    },
  }
}

function coerceReviewLensPacket(raw: unknown): { ok: true; packet: ReviewLensPacket } | { ok: false; reason: string } {
  if (typeof raw !== 'object' || raw === null) return { ok: false, reason: '不是对象' }
  const o = raw as Record<string, unknown>
  const lens = String(o['lens'] ?? '')
  if (!isReviewLens(lens)) return { ok: false, reason: 'lens 非法' }
  const title = String(o['title'] ?? '')
  const focusRaw = o['focus']
  if (!Array.isArray(focusRaw)) return { ok: false, reason: 'focus 非数组' }
  const chapter = Number(o['chapter'])
  if (!Number.isSafeInteger(chapter) || chapter < 1) return { ok: false, reason: 'chapter 非正整数' }
  if (!Array.isArray(o['ledger_checks'])) return { ok: false, reason: 'ledger_checks 非数组' }
  if (typeof o['output_contract'] !== 'object' || o['output_contract'] === null) {
    return { ok: false, reason: 'output_contract 非对象' }
  }
  if (typeof o['body'] !== 'string') return { ok: false, reason: 'body 非字符串' }

  return {
    ok: true,
    packet: {
      lens,
      title,
      focus: focusRaw.map(String),
      ledger_checks: o['ledger_checks'] as ReviewTask['ledger_checks'],
      output_contract: o['output_contract'] as ReviewTask['output_contract'],
      body: o['body'],
      chapter,
    },
  }
}

function isReviewTier(tier: string): tier is ReviewTier {
  return tier === 'full' || tier === 'sequential' || tier === 'combined'
}

function tierLabel(tier: ReviewTier): string {
  if (tier === 'full') return '满审'
  if (tier === 'sequential') return '顺序审'
  return '合审'
}

function lensLabel(lens: ReviewLens): string {
  if (lens === 'reader') return '读者审'
  if (lens === 'editor') return '编辑审'
  return '设定校对'
}

const SEVERITIES: ReadonlySet<string> = new Set(['S1', 'S2', 'S3', 'S4'])
function isReviewSeverity(s: string): s is ReviewIssue['severity'] {
  return SEVERITIES.has(s)
}

const CATEGORIES: ReadonlySet<string> = new Set([
  'high_point', 'reader_pull', 'pacing', 'ooc', 'logic', 'consistency',
  'continuity', 'setting', 'timeline', 'strand', 'ledger', 'safety',
])
function isReviewCategory(c: string): c is ReviewIssue['category'] {
  return CATEGORIES.has(c)
}

const LENSES: ReadonlySet<string> = new Set(['reader', 'editor', 'continuity'])
function isReviewLens(l: string): l is ReviewLens {
  return LENSES.has(l)
}

export { aggregateReviewIssues }
