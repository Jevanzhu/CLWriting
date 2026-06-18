/**
 * 三审任务书 + 审查规格阶梯的确定性契约 —— 依据 M4 #20/#22。
 *
 * 真模型只负责按任务书产出 JSON；降级判定、证据硬闸、问题聚合和验收归一化
 * 必须留在脚本层，避免主流程口头代替三审。
 */

import type { CheckReport } from '../check/types.js'

export type ReviewLens = 'reader' | 'editor' | 'continuity'

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

export interface LedgerCheck {
  lead_id: string
  chapter: number
  verb: string
  evidence: string
}

export interface ReviewTask {
  lens: ReviewLens
  title: string
  must_run: boolean
  focus: string[]
  ledger_checks: LedgerCheck[]
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
      calls: 1 | 3
      fallback: string
      lenses_run: ReviewLens[]
      ledger_check: '已跑'
      downgrade_reason?: string
    }
  | {
      ok: false
      requested_tier: ReviewTier
      calls: 1 | 3
      fallback: string
      reason: string
    }

export const REVIEW_LENSES: ReviewLens[] = ['reader', 'editor', 'continuity']

const SEVERITY_RANK: Record<ReviewSeverity, number> = {
  S1: 4,
  S2: 3,
  S3: 2,
  S4: 1,
}

/** 从机检 byproducts 生成三审任务书。设定校对的账本核对恒跑。 */
export function buildReviewTasks(report: CheckReport): ReviewTask[] {
  const ledgerChecks = (report.byproducts?.leadChanges ?? []).map((change) => ({
    lead_id: change.leadId,
    chapter: change.chapter,
    verb: change.verb,
    evidence: change.evidence,
  }))

  return [
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
    {
      lens: 'continuity',
      title: '设定校对',
      must_run: true,
      focus: ['设定连续', '时间线', '多线承接', '账本属实核对'],
      ledger_checks: ledgerChecks,
      output_contract: baseOutputContract(),
    },
  ]
}

/** 按 M4 #22 选择能诚实执行的最高审查档。 */
export function selectReviewTier(input: {
  capabilities: ReviewHostCapabilities
  remaining_calls: number
  high_risk: boolean
}): ReviewTierDecision {
  const remaining = Math.max(0, Math.floor(input.remaining_calls))

  if (input.high_risk) {
    if (!input.capabilities.parallel_subagents) {
      return {
        ok: false,
        requested_tier: 'full',
        calls: 3,
        fallback: '风险章满审跑不了',
        reason: '高风险章禁止降级，但当前宿主不支持并行独立三审；请换宿主或人工确认后再继续。',
      }
    }
    if (remaining < 3) {
      return {
        ok: false,
        requested_tier: 'full',
        calls: 3,
        fallback: '风险章满审跑不了',
        reason: `高风险章必须满审，还需要 3 次调用；当前只剩 ${remaining} 次，请提额或降低前序 best-of-N。`,
      }
    }
    return { ok: true, requested_tier: 'full', tier: 'full', calls: 3, fallback: '无', lenses_run: REVIEW_LENSES, ledger_check: '已跑' }
  }

  if (input.capabilities.parallel_subagents && remaining >= 3) {
    return { ok: true, requested_tier: 'full', tier: 'full', calls: 3, fallback: '无', lenses_run: REVIEW_LENSES, ledger_check: '已跑' }
  }

  if (!input.capabilities.parallel_subagents && input.capabilities.multiple_calls && remaining >= 3) {
    return {
      ok: true,
      requested_tier: 'full',
      tier: 'sequential',
      calls: 3,
      fallback: '无并行能力',
      lenses_run: REVIEW_LENSES,
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
      lenses_run: REVIEW_LENSES,
      ledger_check: '已跑',
      downgrade_reason: input.capabilities.parallel_subagents
        ? '剩余调用不足以跑满审，普通章降级为合审。'
        : '当前宿主或预算不足以跑三次审查，普通章降级为合审。',
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
  return issue.category === 'ledger' || issue.category === 'safety'
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
