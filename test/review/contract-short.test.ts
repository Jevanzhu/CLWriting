import { test, expect } from 'vitest'
import {
  buildReviewTasks,
  isBlockingIssue,
  REVIEW_LENSES_SHORT,
  selectReviewTier,
  type ReviewIssue,
  type PieceListCheck,
} from '../../src/review/contract.js'
import type { CheckReport } from '../../src/check/types.js'

const emptyReport: CheckReport = { sections: [], byproducts: {} }

// ── buildReviewTasks short 分支 ──────────────────

test('buildReviewTasks short: 产短篇三视角', () => {
  const tasks = buildReviewTasks(emptyReport, 'short')
  expect(tasks.map((t) => t.lens)).toEqual(['hook', 'emotion_peak', 'payoff'])
  expect(tasks.map((t) => t.title)).toEqual(['钩子审', '情绪反转审', '设定收尾审'])
  // 三视角 must_run 全 true（满审不被降级稀释）
  expect(tasks.every((t) => t.must_run)).toBe(true)
})

test('buildReviewTasks long（缺省）: 行为不变，产长篇三视角', () => {
  const tasks = buildReviewTasks(emptyReport)
  expect(tasks.map((t) => t.lens)).toEqual(['reader', 'editor', 'continuity'])
})

test('buildReviewTasks short: 清单核对条目进设定收尾审', () => {
  const listChecks: PieceListCheck[] = [
    { type: 'reversal', subject: '来客即凶手', location: '开头', detail: '雪夜敲门' },
    { type: 'payoff', subject: '半枚玉佩', location: '', detail: '' },
  ]
  const report: CheckReport = { sections: [], byproducts: { pieceListChecks: listChecks } as never }
  const tasks = buildReviewTasks(report, 'short')
  const payoff = tasks.find((t) => t.lens === 'payoff')!
  expect(payoff.list_checks).toHaveLength(2)
  expect(payoff.list_checks![0]!.type).toBe('reversal')
  // 其它视角无清单核对
  const hook = tasks.find((t) => t.lens === 'hook')!
  expect(hook.list_checks).toBeUndefined()
})

// ── REVIEW_LENSES_SHORT 常量 ─────────────────────

test('REVIEW_LENSES_SHORT: 短篇三视角常量', () => {
  expect(REVIEW_LENSES_SHORT).toEqual(['hook', 'emotion_peak', 'payoff'])
})

// ── isBlockingIssue 短篇 category ────────────────

test('isBlockingIssue: reversal/payoff 恒阻断', () => {
  const reversal: ReviewIssue = {
    lens: 'emotion_peak', severity: 'S3', category: 'reversal',
    location: 'l1', evidence: ['e'], issue: '反转无铺垫', fix: '补铺垫',
  }
  const payoff: ReviewIssue = {
    lens: 'payoff', severity: 'S3', category: 'payoff',
    location: 'l2', evidence: ['e'], issue: '伏笔未回收', fix: '补回收',
  }
  expect(isBlockingIssue(reversal)).toBe(true)
  expect(isBlockingIssue(payoff)).toBe(true)
})

test('isBlockingIssue: ledger 长篇仍阻断（零回归）', () => {
  const ledger: ReviewIssue = {
    lens: 'continuity', severity: 'S3', category: 'ledger',
    location: 'l1', evidence: ['e'], issue: '账本造假', fix: 'x',
  }
  expect(isBlockingIssue(ledger)).toBe(true)
})

// ── selectReviewTier short: lenses_run 用短篇三视角 ─

test('selectReviewTier short: 满审 lenses_run = 短篇三视角', () => {
  const d = selectReviewTier({
    capabilities: { parallel_subagents: true, multiple_calls: true },
    remaining_calls: 8,
    high_risk: false,
    kind: 'short',
  })
  expect(d.ok).toBe(true)
  if (!d.ok) return
  expect(d.lenses_run).toEqual(['hook', 'emotion_peak', 'payoff'])
})

test('selectReviewTier long（缺省）: lenses_run = 长篇三视角', () => {
  const d = selectReviewTier({
    capabilities: { parallel_subagents: true, multiple_calls: true },
    remaining_calls: 8,
    high_risk: false,
  })
  expect(d.ok).toBe(true)
  if (!d.ok) return
  expect(d.lenses_run).toEqual(['reader', 'editor', 'continuity'])
})
