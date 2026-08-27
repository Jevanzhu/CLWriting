/**
 * 三审任务书 + 审查规格阶梯的确定性契约 —— 依据 M4 #20/#22。
 *
 * 真模型只负责按任务书产出 JSON；降级判定、证据硬闸、问题聚合和验收归一化
 * 必须留在脚本层，避免主流程口头代替三审。
 */

import type { CheckReport } from '../check/types.js'

export type ReviewLens = 'reader' | 'editor' | 'continuity' | 'hook' | 'emotion_peak' | 'payoff'

export type ReviewSeverity = 'S1' | 'S2' | 'S3' | 'S4'

export type ReviewCategory =
  | 'high_point'
  | 'reader_pull'
  | 'pacing'
  | 'ooc'
  | 'logic'
  | 'consistency'
  | 'continuity'
  | 'setting'
  | 'timeline'
  | 'strand'
  | 'ledger'
  | 'safety'
  // 短篇单章爆破力维（M8 #28 第 4 节）
  | 'hook'
  | 'emotion_peak'
  | 'reversal'
  | 'payoff'

export interface LedgerCheck {
  lead_id: string
  chapter: number
  verb: string
  evidence: string
}

/**
 * 单章清单核对条目（M8 #28 第 3 节，设定收尾审的清单驱动核对对象）。
 *
 * 长篇 ledger_checks 承接机检 byproducts.leadChanges；
 * 短篇无账本，设定收尾审对 清单.md（反转线索表 + 伏笔回收）逐条核对。
 */
export interface PieceListCheck {
  /** 反转线索条目（核心反转 + 铺垫点位置/内容） */
  type: 'reversal' | 'payoff'
  /** 反转：核心反转一句话；伏笔：伏笔描述 */
  subject: string
  /** 反转：铺垫点位置；伏笔：回收位置（空 = 未回收） */
  location: string
  /** 内容（铺垫点内容 / 伏笔回收证据指向） */
  detail: string
}

export interface ReviewTask {
  lens: ReviewLens
  title: string
  must_run: boolean
  focus: string[]
  ledger_checks: LedgerCheck[]
  /** 短篇清单核对条目（M8 #28，设定收尾审用；长篇为空） */
  list_checks?: PieceListCheck[]
  output_contract: {
    json_only: true
    evidence_required: true
    no_score: true
  }
}

export interface ReviewIssue {
  lens: ReviewLens
  severity: ReviewSeverity
  category: ReviewCategory
  location: string
  evidence: string[]
  issue: string
  fix: string
  blocking?: boolean
}

export interface ReviewMeta {
  requested_tier: ReviewTier
  effective_tier: ReviewTier
  fallback: string
  lenses_run: ReviewLens[]
  ledger_check: '已跑' | '跳过'
  downgrade_reason?: string
}

export interface ReviewResult {
  issues: ReviewIssue[]
  summary: string
  meta: ReviewMeta
}

export interface NormalizedReviewResult {
  blockers: ReviewIssue[]
  warnings: ReviewIssue[]
  invalid_issues: ReviewIssue[]
  passed: boolean
}

export type ReviewTier = 'full' | 'sequential' | 'combined'

export interface ReviewHostCapabilities {
  parallel_subagents: boolean
  multiple_calls: boolean
}

export type ReviewTierDecision =
  | {
      ok: true
      requested_tier: ReviewTier
      tier: ReviewTier
      calls: number
      fallback: string
      lenses_run: ReviewLens[]
      ledger_check: '已跑'
      downgrade_reason?: string
    }
  | {
      ok: false
      requested_tier: ReviewTier
      calls: number
      fallback: string
      reason: string
    }

const SEVERITY_RANK: Record<ReviewSeverity, number> = {
  S1: 4,
  S2: 3,
  S3: 2,
  S4: 1,
}

/**
 * 从机检 byproducts 生成三审任务书。设定校对的账本核对恒跑。
 *
 * 长短篇统一按数据存在性条件化：
 * - 基础：reader + editor（恒跑）
 * - 有布线：+ continuity（设定校对，账本清单驱动）
 * - 有 config.short：+ hook / emotion_peak / payoff（短篇单章爆破力三视角，清单驱动核对）
 *
 * R65-26（十三轮）：默认 hasWiring:false——原 true 是反向兜底（短篇书调用方漏传
 * opts 时凭空多出 continuity 视角与账本核对）；生产唯一调用方（run.ts buildReviewPacket）
 * 显式传参，缺省 = 无布线的最小任务书（reader + editor）。
 */
export function buildReviewTasks(
  report: CheckReport,
  opts: { hasWiring: boolean; hasShort: boolean } = { hasWiring: false, hasShort: false },
): ReviewTask[] {
  const tasks: ReviewTask[] = [
    {
      lens: 'reader',
      title: '读者审',
      must_run: true,
      focus: ['爽点交付', '追读牵引', '节奏功能'],
      ledger_checks: [],
      output_contract: baseOutputContract(),
    },
    {
      lens: 'editor',
      title: '编辑审',
      must_run: true,
      focus: ['人物动机', '因果逻辑', '表达可信'],
      ledger_checks: [],
      output_contract: baseOutputContract(),
    },
  ]

  if (opts.hasWiring) {
    const ledgerChecks = (report.byproducts?.leadChanges ?? []).map((change) => ({
      lead_id: change.leadId,
      chapter: change.chapter,
      verb: change.verb,
      evidence: change.evidence,
    }))
    tasks.push({
      lens: 'continuity',
      title: '设定校对',
      must_run: true,
      focus: ['设定连续', '时间线', '多线承接', '账本属实核对'],
      ledger_checks: ledgerChecks,
      output_contract: baseOutputContract(),
    })
  }

  if (opts.hasShort) {
    tasks.push(...buildShortReviewTasks(report))
  }

  return tasks
}

/**
 * 短篇三审任务书（M8 #28 第 2 节，维度重写为单章爆破力）。
 *
 * 三视角围绕「开篇抓人 / 情绪反转到位 / 伏笔收尾不崩」重组，非长篇三视角映射：
 * - 钩子审（hook）：开篇钩子 / 黄金 300 字 / 单章追读牵引 / 表达流畅
 * - 情绪反转审（emotion_peak）：情绪曲线达峰 / 反转信息差成立 / 反转铺垫可回溯 / 人物动机服务反转
 * - 设定收尾审（payoff）：伏笔回收闭合 / 反转线索表清单核对（恒跑）/ 单章设定自洽 / 因果逻辑
 *
 * 设定收尾审承接 清单.md（反转线索表 + 伏笔回收）的清单驱动核对（替代长篇 ledger_checks）。
 */
function buildShortReviewTasks(report: CheckReport): ReviewTask[] {
  // 短篇无账本 byproducts，清单核对条目由调用方经 report 之外的清单解析注入；
  // report.sections 不含清单，这里从 report.byproducts?.pieceListChecks 取（若有）
  const listChecks: PieceListCheck[] = (report.byproducts as { pieceListChecks?: PieceListCheck[] } | undefined)?.pieceListChecks ?? []

  return [
    {
      lens: 'hook',
      title: '钩子审',
      must_run: true,
      focus: ['开篇钩子', '黄金 300 字直入冲突', '单章追读牵引', '表达流畅'],
      ledger_checks: [],
      output_contract: baseOutputContract(),
    },
    {
      lens: 'emotion_peak',
      title: '情绪反转审',
      must_run: true,
      focus: ['情绪曲线达峰', '反转信息差成立可回溯', '反转铺垫支撑', '人物动机服务反转'],
      ledger_checks: [],
      output_contract: baseOutputContract(),
    },
    {
      lens: 'payoff',
      title: '设定收尾审',
      must_run: true,
      focus: ['伏笔回收闭合（弃坑报红）', '反转线索表清单核对', '单章设定自洽', '因果逻辑'],
      ledger_checks: [],
      ...(listChecks.length > 0 ? { list_checks: listChecks } : {}),
      output_contract: baseOutputContract(),
    },
  ]
}

/** 按 M4 #22 选择能诚实执行的最高审查档。lenses 决定 lenses_run（长短混合视角）。 */
export function selectReviewTier(input: {
  capabilities: ReviewHostCapabilities
  remaining_calls: number
  high_risk: boolean
  /** 本次审查实际运行的视角（长短篇由 buildReviewTasks 条件化决定） */
  lenses: ReviewLens[]
}): ReviewTierDecision {
  const remaining = Math.max(0, Math.floor(input.remaining_calls))
  const lensesRun = input.lenses
  // V-P1-8：满审调用数 = 实际视角数（长篇 2-3、短篇 5），不再是硬编码 3——
  // 短篇满审实际产 5 份 packets，预算闸只校验 3 会让 planned_calls 与分包数自相矛盾，
  // 高风险章「必须满审」的校验同样低估。
  const fullCalls = Math.max(1, lensesRun.length)

  if (input.high_risk) {
    // X-P2-7：高风险章的红线是「禁止降级合审」，不是「必须有并行能力」——顺序满审
    // （多次独立调用，独立性由分包+分视角保证）与并行满审同构，本端点实现本就是串行循环。
    // 原判定「无并行能力即 fail」与 capabilities 硬编码 false 组合成死端：红项章三审必 500。
    if (remaining < fullCalls) {
      return {
        ok: false,
        requested_tier: 'full',
        calls: fullCalls,
        fallback: '风险章满审跑不了',
        reason: `高风险章（机检有红项）必须满审，还需要 ${fullCalls} 次调用；当前只剩 ${remaining} 次。请先修复红项（或跑全自动写章自愈）再审，或提额调用数。`,
      }
    }
    if (input.capabilities.parallel_subagents) {
      return { ok: true, requested_tier: 'full', tier: 'full', calls: fullCalls, fallback: '无', lenses_run: lensesRun, ledger_check: '已跑' }
    }
    if (input.capabilities.multiple_calls) {
      return {
        ok: true,
        requested_tier: 'full',
        tier: 'sequential',
        calls: fullCalls,
        fallback: '无并行能力',
        lenses_run: lensesRun,
        ledger_check: '已跑',
        downgrade_reason: '高风险章：宿主不支持并行独立三审，降级为顺序满审（不降合审）。',
      }
    }
    return {
      ok: false,
      requested_tier: 'full',
      calls: fullCalls,
      fallback: '风险章满审跑不了',
      reason: '高风险章（机检有红项）禁止降级合审，但当前宿主不支持多次独立调用；请先修复红项（或跑全自动写章自愈）再审。',
    }
  }

  if (input.capabilities.parallel_subagents && remaining >= fullCalls) {
    return { ok: true, requested_tier: 'full', tier: 'full', calls: fullCalls, fallback: '无', lenses_run: lensesRun, ledger_check: '已跑' }
  }

  if (!input.capabilities.parallel_subagents && input.capabilities.multiple_calls && remaining >= fullCalls) {
    return {
      ok: true,
      requested_tier: 'full',
      tier: 'sequential',
      calls: fullCalls,
      fallback: '无并行能力',
      lenses_run: lensesRun,
      ledger_check: '已跑',
      downgrade_reason: '当前宿主不支持并行独立 subagent，降级为顺序三审。',
    }
  }

  if (remaining >= 1) {
    const fallback = input.capabilities.multiple_calls ? '预算极限' : '工具不可用'
    return {
      ok: true,
      requested_tier: 'full',
      tier: 'combined',
      calls: 1,
      fallback,
      lenses_run: lensesRun,
      ledger_check: '已跑',
      downgrade_reason: input.capabilities.parallel_subagents
        ? '剩余调用不足以跑满审，普通章降级为合审。'
        : '当前宿主或预算不足以跑满审，普通章降级为合审。',
    }
  }

  return {
    ok: false,
    requested_tier: 'full',
    calls: 1,
    fallback: '预算极限',
    reason: '本章 AI 调用预算已用完，无法启动三审；请提额或回到前序步骤压缩调用。',
  }
}

/** 合并满审 / 顺序审的多份 issue：同 lens/category/location 去重，取最严。 */
export function aggregateReviewIssues(issues: ReviewIssue[]): ReviewIssue[] {
  const byKey = new Map<string, ReviewIssue>()

  for (const issue of issues) {
    const key = `${issue.lens}\0${issue.category}\0${issue.location.trim()}`
    const existing = byKey.get(key)
    if (existing === undefined) {
      byKey.set(key, cloneIssue(issue))
      continue
    }

    if (SEVERITY_RANK[issue.severity] > SEVERITY_RANK[existing.severity]) {
      existing.severity = issue.severity
    }
    existing.blocking = Boolean(existing.blocking || issue.blocking)
    existing.evidence = uniq([...existing.evidence, ...issue.evidence].map((item) => item.trim()).filter(Boolean))
    if (existing.issue.trim() === '' && issue.issue.trim() !== '') existing.issue = issue.issue
    if (existing.fix.trim() === '' && issue.fix.trim() !== '') existing.fix = issue.fix
  }

  return [...byKey.values()].sort((a, b) => {
    const rank = SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity]
    if (rank !== 0) return rank
    return `${a.lens}:${a.category}:${a.location}`.localeCompare(`${b.lens}:${b.category}:${b.location}`)
  })
}

/** 归一化三审结果：空 evidence 的 issue 不成立，但会让审稿单判无效。 */
export function normalizeReviewResult(result: ReviewResult): NormalizedReviewResult {
  const aggregated = aggregateReviewIssues(result.issues)
  const invalidIssues = aggregated.filter((issue) => !hasEvidence(issue))
  const validIssues = aggregated.filter((issue) => hasEvidence(issue))
  const blockers = validIssues.filter((issue) => isBlockingIssue(issue))
  const warnings = validIssues.filter((issue) => !isBlockingIssue(issue))

  return {
    blockers,
    warnings,
    invalid_issues: invalidIssues,
    passed: blockers.length === 0 && invalidIssues.length === 0,
  }
}

export function isBlockingIssue(issue: ReviewIssue): boolean {
  if (issue.blocking) return true
  if (issue.severity === 'S1' || issue.severity === 'S2') return true
  // 长篇 ledger（账本造假）+ 短篇 reversal（反转信息差不成立）/ payoff（伏笔未回收）+ safety 恒阻断
  // （#20 第 5 节 + M8 #28 第 4 节：这些 category 是「造假/弃坑」级，必阻断）
  return (
    issue.category === 'ledger' ||
    issue.category === 'reversal' ||
    issue.category === 'payoff' ||
    issue.category === 'safety'
  )
}

function baseOutputContract(): ReviewTask['output_contract'] {
  return { json_only: true, evidence_required: true, no_score: true }
}

function hasEvidence(issue: ReviewIssue): boolean {
  return issue.evidence.some((item) => item.trim() !== '')
}

function cloneIssue(issue: ReviewIssue): ReviewIssue {
  return {
    lens: issue.lens,
    severity: issue.severity,
    category: issue.category,
    location: issue.location,
    evidence: [...issue.evidence],
    issue: issue.issue,
    fix: issue.fix,
    ...(issue.blocking !== undefined ? { blocking: issue.blocking } : {}),
  }
}

function uniq(items: string[]): string[] {
  return [...new Set(items)]
}
