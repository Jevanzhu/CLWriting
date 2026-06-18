import { test, expect } from 'vitest'
import {
  aggregateReviewIssues,
  buildReviewTasks,
  normalizeReviewResult,
  selectReviewTier,
  type ReviewIssue,
} from '../../src/review/contract.js'
import type { CheckReport } from '../../src/check/types.js'

test('buildReviewTasks: 三审任务书固定三视角，账本清单只进入设定校对且恒跑', () => {
  const report: CheckReport = {
    sections: [],
    byproducts: {
      leadChanges: [
        { leadId: '伏笔-031', chapter: 12, verb: '推进', evidence: '他终于看见焦痕背后的掌印。' },
      ],
    },
  }

  const tasks = buildReviewTasks(report)

  expect(tasks.map((task) => task.lens)).toEqual(['reader', 'editor', 'continuity'])
  expect(tasks.every((task) => task.must_run)).toBe(true)
  expect(tasks[0]!.ledger_checks).toHaveLength(0)
  expect(tasks[1]!.ledger_checks).toHaveLength(0)
  expect(tasks[2]!.title).toBe('设定校对')
  expect(tasks[2]!.ledger_checks).toEqual([
    { lead_id: '伏笔-031', chapter: 12, verb: '推进', evidence: '他终于看见焦痕背后的掌印。' },
  ])
  expect(tasks[2]!.output_contract).toEqual({ json_only: true, evidence_required: true, no_score: true })
})

test('selectReviewTier: 宿主支持并行且预算足够时默认满审', () => {
  const decision = selectReviewTier({
    capabilities: { parallel_subagents: true, multiple_calls: true },
    remaining_calls: 3,
    high_risk: false,
  })

  expect(decision).toMatchObject({
    ok: true,
    requested_tier: 'full',
    tier: 'full',
    calls: 3,
    fallback: '无',
    lenses_run: ['reader', 'editor', 'continuity'],
    ledger_check: '已跑',
  })
})

test('selectReviewTier: 无并行能力但可多次调用时诚实降级为顺序审', () => {
  const decision = selectReviewTier({
    capabilities: { parallel_subagents: false, multiple_calls: true },
    remaining_calls: 5,
    high_risk: false,
  })

  expect(decision.ok).toBe(true)
  if (decision.ok) {
    expect(decision.tier).toBe('sequential')
    expect(decision.calls).toBe(3)
    expect(decision.requested_tier).toBe('full')
    expect(decision.fallback).toBe('无并行能力')
    expect(decision.lenses_run).toEqual(['reader', 'editor', 'continuity'])
    expect(decision.ledger_check).toBe('已跑')
    expect(decision.downgrade_reason).toContain('不支持并行')
  }
})

test('selectReviewTier: 普通章预算紧时可合审，高风险章必须停下逼决策', () => {
  const normal = selectReviewTier({
    capabilities: { parallel_subagents: true, multiple_calls: true },
    remaining_calls: 1,
    high_risk: false,
  })
  expect(normal.ok).toBe(true)
  if (normal.ok) {
    expect(normal.tier).toBe('combined')
    expect(normal.calls).toBe(1)
    expect(normal.fallback).toBe('预算极限')
    expect(normal.downgrade_reason).toContain('普通章降级为合审')
  }

  const highRisk = selectReviewTier({
    capabilities: { parallel_subagents: true, multiple_calls: true },
    remaining_calls: 2,
    high_risk: true,
  })
  expect(highRisk.ok).toBe(false)
  if (!highRisk.ok) {
    expect(highRisk.calls).toBe(3)
    expect(highRisk.fallback).toBe('风险章满审跑不了')
    expect(highRisk.reason).toContain('高风险章必须满审')
  }
})

test('aggregateReviewIssues: 同 lens/category/location 去重，severity 与 blocking 取最严', () => {
  const issues: ReviewIssue[] = [
    {
      lens: 'continuity',
      severity: 'S3',
      category: 'ledger',
      location: '第12章第30段',
      evidence: ['焦痕'],
      issue: '账本推进证据不足。',
      fix: '补出推进动作。',
    },
    {
      lens: 'continuity',
      severity: 'S1',
      category: 'ledger',
      location: '第12章第30段',
      evidence: ['掌印'],
      issue: '同一问题的更严判断。',
      fix: '重写该段。',
      blocking: true,
    },
  ]

  const aggregated = aggregateReviewIssues(issues)

  expect(aggregated).toHaveLength(1)
  expect(aggregated[0]!.severity).toBe('S1')
  expect(aggregated[0]!.blocking).toBe(true)
  expect(aggregated[0]!.evidence).toEqual(['焦痕', '掌印'])
})

test('normalizeReviewResult: 账本类 issue 自动阻断，空 evidence 让审稿单无效', () => {
  const normalized = normalizeReviewResult({
    meta: {
      requested_tier: 'full',
      effective_tier: 'full',
      fallback: '无',
      lenses_run: ['reader', 'editor', 'continuity'],
      ledger_check: '已跑',
    },
    summary: '两条问题。',
    issues: [
      {
        lens: 'continuity',
        severity: 'S4',
        category: 'ledger',
        location: '第12章第30段',
        evidence: ['焦痕'],
        issue: '声称推进，但正文只写了发现痕迹。',
        fix: '补出真推进。',
      },
      {
        lens: 'reader',
        severity: 'S3',
        category: 'reader_pull',
        location: '第12章结尾',
        evidence: [''],
        issue: '结尾吸引力不足。',
        fix: '补钩子。',
      },
    ],
  })

  expect(normalized.blockers.map((issue) => issue.category)).toEqual(['ledger'])
  expect(normalized.invalid_issues).toHaveLength(1)
  expect(normalized.passed).toBe(false)
})
