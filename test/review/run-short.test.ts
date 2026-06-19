import { test, expect } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  buildReviewPacket,
  collectReviewIssues,
  renderReviewVerdict,
  lensIssuesFileName,
  COMBINED_ISSUES_FILE,
  type ReviewExecutionPacket,
} from '../../src/review/run.js'
import type { CheckReport } from '../../src/check/types.js'
import type { ReviewIssue } from '../../src/review/contract.js'

const emptyReport: CheckReport = { sections: [], byproducts: {} }

/** 造短篇满审 packet（短篇三视角） */
function makeShortFullPacket(workDir: string): ReviewExecutionPacket {
  const built = buildReviewPacket({
    checkReport: emptyReport,
    body: '短篇正文。',
    chapter: 1,
    workDir,
    capabilities: { parallel_subagents: true, multiple_calls: true },
    remaining_calls: 8,
    high_risk: false,
    kind: 'short',
  })
  if (!built.ok) throw new Error('short packet build failed')
  return built.packet
}

// ── buildReviewPacket short: 三视角分包 ──────────

test('buildReviewPacket short: 满审产短篇三视角分包', () => {
  const workDir = mkdtempSync(join(tmpdir(), 'review-short-'))
  const built = buildReviewPacket({
    checkReport: emptyReport,
    body: '正文。',
    chapter: 1,
    workDir,
    capabilities: { parallel_subagents: true, multiple_calls: true },
    remaining_calls: 8,
    high_risk: false,
    kind: 'short',
  })
  expect(built.ok).toBe(true)
  if (!built.ok) return
  const { packet } = built
  expect(packet.lenses_run).toEqual(['hook', 'emotion_peak', 'payoff'])
  expect(packet.packets.map((p) => p.lens)).toEqual(['hook', 'emotion_peak', 'payoff'])
  rmSync(workDir, { recursive: true, force: true })
})

// ── 白名单双改：短篇 category/lens 不进 bad_entries ──

test('collectReviewIssues short: reversal issue 不被丢弃进 bad_entries', () => {
  const workDir = mkdtempSync(join(tmpdir(), 'review-short-'))
  const packet = makeShortFullPacket(workDir)
  mkdirSync(packet.out_dir, { recursive: true })

  // 钩子审 / 设定收尾审：无问题
  writeFileSync(join(packet.out_dir, lensIssuesFileName('hook')), '[]', 'utf-8')
  writeFileSync(join(packet.out_dir, lensIssuesFileName('payoff')), '[]', 'utf-8')
  // 情绪反转审：反转无铺垫 → reversal blocker（关键：category='reversal' 必须过白名单）
  const emotionIssues: ReviewIssue[] = [
    {
      lens: 'emotion_peak',
      severity: 'S2',
      category: 'reversal',
      location: '反转段',
      evidence: ['反转「来客即凶手」前文无任何铺垫支撑'],
      issue: '反转信息差不成立，铺垫不足以回溯。',
      fix: '补至少 3 处铺垫点支撑反转。',
    },
  ]
  writeFileSync(join(packet.out_dir, lensIssuesFileName('emotion_peak')), JSON.stringify(emotionIssues), 'utf-8')

  const collected = collectReviewIssues({ packet })
  expect(collected.ok).toBe(true)
  // 关键断言：reversal issue 被正常回收，不进 bad_entries
  expect(collected.bad_entries).toHaveLength(0)
  expect(collected.normalized.blockers.some((i) => i.category === 'reversal')).toBe(true)
  expect(collected.normalized.passed).toBe(false)
  rmSync(workDir, { recursive: true, force: true })
})

// ── 合审档：短篇三视角单包覆盖 ────────────────────

test('collectReviewIssues short 合审: 单包覆盖三视角不缺', () => {
  const workDir = mkdtempSync(join(tmpdir(), 'review-short-'))
  const built = buildReviewPacket({
    checkReport: emptyReport,
    body: '正文。',
    chapter: 1,
    workDir,
    capabilities: { parallel_subagents: false, multiple_calls: false },
    remaining_calls: 1,
    high_risk: false,
    kind: 'short',
  })
  expect(built.ok).toBe(true)
  if (!built.ok) return
  const { packet } = built
  expect(packet.tier).toBe('combined')
  mkdirSync(packet.out_dir, { recursive: true })

  // 合审单包：payoff 为锚，覆盖三视角
  const combinedIssues: ReviewIssue[] = [
    {
      lens: 'payoff', severity: 'S3', category: 'payoff',
      location: '伏笔', evidence: ['半枚玉佩未回收'], issue: '伏笔弃坑', fix: '补回收',
    },
  ]
  writeFileSync(join(packet.out_dir, COMBINED_ISSUES_FILE), JSON.stringify(combinedIssues), 'utf-8')

  const collected = collectReviewIssues({ packet })
  expect(collected.ok).toBe(true)
  expect(collected.missing_lenses).toHaveLength(0) // 合审单包覆盖三视角
  rmSync(workDir, { recursive: true, force: true })
})

// ── renderReviewVerdict short: 清单核对阻断专列 ────

test('renderReviewVerdict short: reversal blocker 渲染清单核对阻断专列', () => {
  const workDir = mkdtempSync(join(tmpdir(), 'review-short-'))
  const packet = makeShortFullPacket(workDir)
  mkdirSync(packet.out_dir, { recursive: true })
  writeFileSync(join(packet.out_dir, lensIssuesFileName('hook')), '[]', 'utf-8')
  writeFileSync(join(packet.out_dir, lensIssuesFileName('payoff')), '[]', 'utf-8')
  const emotionIssues: ReviewIssue[] = [
    {
      lens: 'emotion_peak', severity: 'S2', category: 'reversal',
      location: '反转段', evidence: ['无铺垫'], issue: '反转不成立', fix: '补铺垫',
    },
  ]
  writeFileSync(join(packet.out_dir, lensIssuesFileName('emotion_peak')), JSON.stringify(emotionIssues), 'utf-8')

  const collected = collectReviewIssues({ packet })
  expect(collected.ok).toBe(true)
  const text = renderReviewVerdict(collected)
  expect(text).toContain('清单核对阻断')
  rmSync(workDir, { recursive: true, force: true })
})
