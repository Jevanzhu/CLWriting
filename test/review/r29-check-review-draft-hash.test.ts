/**
 * B-11（二十九轮）：draft_path/draft_hash 恰缺一 = 漂移（fail-closed）。
 *
 * 生产链恒双传（studio/server/api/review.ts R62-33 接线），原实现「缺一即跳过
 * 校验」让半接线的打包方静默失去漂移守卫；改按漂移同判注入阻断 issue。
 * 双缺保留跳过：无草稿绑定的回放/直造 packet 合法形态，非漂移信号。
 */
import { test, expect } from 'vitest'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { mkdtempTracked } from '../helpers/temp-dir.js'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildReviewPacket, collectReviewIssues, lensIssuesFileName, type ReviewExecutionPacket } from '../../src/review/run.js'
import type { CheckReport } from '../../src/check/types.js'

const report: CheckReport = { sections: [], byproducts: { leadChanges: [] } }

function makePacket(workDir: string): ReviewExecutionPacket {
  const built = buildReviewPacket({
    checkReport: report,
    body: '正文。',
    chapter: 1,
    workDir,
    capabilities: { parallel_subagents: true, multiple_calls: true },
    remaining_calls: 8,
    high_risk: false,
    hasWiring: true,
    hasShort: false,
  })
  if (!built.ok) throw new Error('packet build failed')
  return built.packet
}

/** 三视角齐回收（审稿单成立的内容面） */
function writeAllLenses(packet: ReviewExecutionPacket): void {
  mkdirSync(packet.out_dir, { recursive: true })
  for (const lens of packet.lenses_run) {
    writeFileSync(join(packet.out_dir, lensIssuesFileName(lens)), '[]', 'utf-8')
  }
}

test('B-11: draft_path/draft_hash 恰缺一 → 审稿单不成立（注入阻断 issue，fail-closed）', () => {
  const workDir = mkdtempTracked(join(tmpdir(), 'r29-review-half-'))
  try {
    // 只有 path 没有 hash：漂移校验无法执行 → 按漂移同判
    const pathOnly = makePacket(workDir)
    pathOnly.draft_path = join(workDir, 'draft.md')
    delete (pathOnly as Partial<ReviewExecutionPacket>).draft_hash
    writeAllLenses(pathOnly)
    const r1 = collectReviewIssues({ packet: pathOnly })
    expect(r1.ok).toBe(false)
    expect(r1.normalized.passed).toBe(false)
    expect(r1.normalized.blockers).toHaveLength(1)
    expect(r1.normalized.blockers[0]!.issue).toContain('三审未完成')
    expect(r1.bad_entries[0]!.reason).toContain('恰缺其一')

    // 只有 hash 没有 path：同判
    const hashOnly = makePacket(workDir)
    hashOnly.draft_hash = 'deadbeef'
    delete (hashOnly as Partial<ReviewExecutionPacket>).draft_path
    writeAllLenses(hashOnly)
    const r2 = collectReviewIssues({ packet: hashOnly })
    expect(r2.ok).toBe(false)
    expect(r2.normalized.passed).toBe(false)
    expect(r2.bad_entries[0]!.reason).toContain('恰缺其一')
  } finally {
    rmSync(workDir, { recursive: true, force: true })
  }
})

test('B-11: 双缺（无草稿绑定）保留跳过语义 → 审稿单成立', () => {
  const workDir = mkdtempTracked(join(tmpdir(), 'r29-review-none-'))
  try {
    const packet = makePacket(workDir) // buildReviewPacket 未传 → 双缺
    expect(packet.draft_path).toBeUndefined()
    expect(packet.draft_hash).toBeUndefined()
    writeAllLenses(packet)
    const r = collectReviewIssues({ packet })
    expect(r.ok).toBe(true)
    expect(r.missing_lenses).toHaveLength(0)
  } finally {
    rmSync(workDir, { recursive: true, force: true })
  }
})

test('B-11: 双传走真校验（错值 → stale 判定，非「恰缺其一」分支）', () => {
  const workDir = mkdtempTracked(join(tmpdir(), 'r29-review-both-'))
  try {
    const draftPath = join(workDir, 'draft.md')
    writeFileSync(draftPath, '正文。', 'utf-8')
    const packet = makePacket(workDir)
    packet.draft_path = draftPath
    packet.draft_hash = 'deadbeef' // 与盘上不符 → R61-13 stale 路径
    writeAllLenses(packet)
    const r = collectReviewIssues({ packet })
    expect(r.ok).toBe(false)
    expect(r.bad_entries[0]!.reason).toContain('draft_hash 不符')
  } finally {
    rmSync(workDir, { recursive: true, force: true })
  }
})
