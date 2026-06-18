import { test, expect } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  buildReviewPacket,
  collectReviewIssues,
  formatReviewPacket,
  renderReviewVerdict,
  writeReviewVerdict,
  readReviewVerdict,
  readReviewPacket,
  lensIssuesFileName,
  COMBINED_ISSUES_FILE,
  REVIEW_PACKET_FILE,
  REVIEW_VERDICT_MARKER,
  writeReviewPacket,
  type ReviewExecutionPacket,
} from '../../src/review/run.js'
import type { CheckReport } from '../../src/check/types.js'
import type { ReviewIssue, ReviewLens } from '../../src/review/contract.js'

// 账本变动清单（机检 byproducts → 设定校对账本核对项）
const reportWithLedger: CheckReport = {
  sections: [],
  byproducts: {
    leadChanges: [
      { leadId: '伏笔-031', chapter: 12, verb: '推进', evidence: '他终于看见焦痕背后的掌印。' },
    ],
  },
}

// ── buildReviewPacket ─────────────────────────────

test('buildReviewPacket: 满审档位 → 三份独立分包，账本清单只进设定校对', () => {
  const workDir = mkdtempSync(join(tmpdir(), 'review-run-'))
  const built = buildReviewPacket({
    checkReport: reportWithLedger,
    body: '第12章正文。',
    chapter: 12,
    workDir,
    capabilities: { parallel_subagents: true, multiple_calls: true },
    remaining_calls: 8,
    high_risk: false,
  })
  expect(built.ok).toBe(true)
  if (!built.ok) return

  const { packet } = built
  expect(packet.tier).toBe('full')
  expect(packet.planned_calls).toBe(3)
  expect(packet.packets).toHaveLength(3)
  expect(packet.packets.map((p) => p.lens)).toEqual(['reader', 'editor', 'continuity'])

  // 账本清单只在设定校对（continuity）分包
  const continuity = packet.packets.find((p) => p.lens === 'continuity')!
  expect(continuity.ledger_checks).toHaveLength(1)
  expect(continuity.ledger_checks[0]!.lead_id).toBe('伏笔-031')
  const reader = packet.packets.find((p) => p.lens === 'reader')!
  expect(reader.ledger_checks).toHaveLength(0)
  expect(packet.out_dir).toBe(join(workDir, '三审'))
  rmSync(workDir, { recursive: true, force: true })
})

test('buildReviewPacket: 合审档位 → 单分包但账本清单不丢', () => {
  const workDir = mkdtempSync(join(tmpdir(), 'review-run-'))
  const built = buildReviewPacket({
    checkReport: reportWithLedger,
    body: '正文。',
    chapter: 5,
    workDir,
    capabilities: { parallel_subagents: true, multiple_calls: true },
    remaining_calls: 1,
    high_risk: false,
  })
  expect(built.ok).toBe(true)
  if (!built.ok) return

  const { packet } = built
  expect(packet.tier).toBe('combined')
  expect(packet.planned_calls).toBe(1)
  expect(packet.packets).toHaveLength(1)
  // 合审单包仍带账本清单（不被降级稀释）
  expect(packet.packets[0]!.ledger_checks).toHaveLength(1)
  expect(packet.packets[0]!.ledger_checks[0]!.lead_id).toBe('伏笔-031')
  rmSync(workDir, { recursive: true, force: true })
})

test('buildReviewPacket: 高风险章预算不足 → 拒绝（禁止降级）', () => {
  const workDir = mkdtempSync(join(tmpdir(), 'review-run-'))
  const built = buildReviewPacket({
    checkReport: { sections: [] },
    body: '',
    chapter: 1,
    workDir,
    capabilities: { parallel_subagents: true, multiple_calls: true },
    remaining_calls: 2,
    high_risk: true,
  })
  expect(built.ok).toBe(false)
  if (!built.ok) expect(built.reason).toContain('高风险章')
  rmSync(workDir, { recursive: true, force: true })
})

// ── collectReviewIssues ───────────────────────────

/** 造一个满审 packet（三视角）便于 collect 测试 */
function makeFullPacket(workDir: string): ReviewExecutionPacket {
  const built = buildReviewPacket({
    checkReport: reportWithLedger,
    body: '正文。',
    chapter: 12,
    workDir,
    capabilities: { parallel_subagents: true, multiple_calls: true },
    remaining_calls: 8,
    high_risk: false,
  })
  if (!built.ok) throw new Error('packet build failed')
  return built.packet
}

test('collectReviewIssues: 回收三视角 issues → 设定校对逮到账本 blocker', () => {
  const workDir = mkdtempSync(join(tmpdir(), 'review-run-'))
  const packet = makeFullPacket(workDir)
  mkdirSync(packet.out_dir, { recursive: true })

  // 读者审 / 编辑审：无问题
  writeFileSync(join(packet.out_dir, lensIssuesFileName('reader')), '[]', 'utf-8')
  writeFileSync(join(packet.out_dir, lensIssuesFileName('editor')), '[]', 'utf-8')
  // 设定校对：账本声明推进但正文无证据 → ledger blocker
  const continuityIssues: ReviewIssue[] = [
    {
      lens: 'continuity',
      severity: 'S2',
      category: 'ledger',
      location: '第12章第30段',
      evidence: ['正文只写「他看见痕迹」，未见推进掌印的描写'],
      issue: '账本 伏笔-031 声明「推进」但正文证据不足，疑似账本造假。',
      fix: '补出掌印推进的具体动作，或修正账本动词。',
    },
  ]
  writeFileSync(join(packet.out_dir, lensIssuesFileName('continuity')), JSON.stringify(continuityIssues), 'utf-8')

  const collected = collectReviewIssues({ packet })
  expect(collected.ok).toBe(true)
  expect(collected.missing_lenses).toHaveLength(0)
  // ledger 自动阻断
  expect(collected.normalized.blockers.some((i) => i.category === 'ledger')).toBe(true)
  expect(collected.normalized.passed).toBe(false)
  rmSync(workDir, { recursive: true, force: true })
})

test('collectReviewIssues: 缺视角 → 审稿单不成立', () => {
  const workDir = mkdtempSync(join(tmpdir(), 'review-run-'))
  const packet = makeFullPacket(workDir)
  mkdirSync(packet.out_dir, { recursive: true })
  // 只回写 reader / editor，缺 continuity
  writeFileSync(join(packet.out_dir, lensIssuesFileName('reader')), '[]', 'utf-8')
  writeFileSync(join(packet.out_dir, lensIssuesFileName('editor')), '[]', 'utf-8')

  const collected = collectReviewIssues({ packet })
  expect(collected.ok).toBe(false)
  expect(collected.missing_lenses).toContain('continuity')
  rmSync(workDir, { recursive: true, force: true })
})

test('collectReviewIssues: 空 evidence issue → 判无效（审稿单不成立）', () => {
  const workDir = mkdtempSync(join(tmpdir(), 'review-run-'))
  const packet = makeFullPacket(workDir)
  mkdirSync(packet.out_dir, { recursive: true })
  // 三视角都回写，但有个空 evidence issue
  const badIssue: ReviewIssue[] = [
    { lens: 'reader', severity: 'S3', category: 'reader_pull', location: '结尾', evidence: [''], issue: '吸引力不足', fix: '补钩子' },
  ]
  writeFileSync(join(packet.out_dir, lensIssuesFileName('reader')), JSON.stringify(badIssue), 'utf-8')
  writeFileSync(join(packet.out_dir, lensIssuesFileName('editor')), '[]', 'utf-8')
  writeFileSync(join(packet.out_dir, lensIssuesFileName('continuity')), '[]', 'utf-8')

  const collected = collectReviewIssues({ packet })
  expect(collected.normalized.invalid_issues).toHaveLength(1)
  expect(collected.normalized.passed).toBe(false)
  rmSync(workDir, { recursive: true, force: true })
})

test('collectReviewIssues: 合审单文件回收三视角', () => {
  const workDir = mkdtempSync(join(tmpdir(), 'review-run-'))
  const built = buildReviewPacket({
    checkReport: reportWithLedger,
    body: '正文。',
    chapter: 5,
    workDir,
    capabilities: { parallel_subagents: true, multiple_calls: true },
    remaining_calls: 1,
    high_risk: false,
  })
  if (!built.ok) throw new Error('build failed')
  mkdirSync(built.packet.out_dir, { recursive: true })
  // 合审单文件：issues 用 lens 字段区分视角
  writeFileSync(
    join(built.packet.out_dir, COMBINED_ISSUES_FILE),
    JSON.stringify([
      { lens: 'reader', severity: 'S4', category: 'pacing', location: '中段', evidence: ['节奏偏慢'], issue: '拖沓', fix: '压缩' },
    ]),
    'utf-8',
  )
  const collected = collectReviewIssues({ packet: built.packet })
  expect(collected.ok).toBe(true)
  expect(collected.collected_lenses).toEqual(expect.arrayContaining(['reader', 'editor', 'continuity']))
  expect(collected.normalized.warnings.length + collected.normalized.blockers.length).toBe(1)
  rmSync(workDir, { recursive: true, force: true })
})

test('writeReviewPacket/readReviewPacket: run 落盘的执行包可被 collect 固定读取', () => {
  const workDir = mkdtempSync(join(tmpdir(), 'review-run-'))
  const packet = makeFullPacket(workDir)
  const path = writeReviewPacket({ ...packet, draft_path: '/tmp/草稿.md', draft_hash: 'sha256:test' })

  expect(path).toBe(join(packet.out_dir, REVIEW_PACKET_FILE))
  const loaded = readReviewPacket(workDir)
  expect(loaded.ok).toBe(true)
  if (loaded.ok) {
    expect(loaded.packet.chapter).toBe(12)
    expect(loaded.packet.draft_hash).toBe('sha256:test')
    expect(loaded.packet.packets).toHaveLength(3)
  }

  rmSync(workDir, { recursive: true, force: true })
})

// ── 审稿单渲染 + 裁决读取 ─────────────────────────

test('renderReviewVerdict: 有账本阻断 → 审稿单突出账本核对专列 + 不能直接通过', () => {
  const workDir = mkdtempSync(join(tmpdir(), 'review-run-'))
  const packet = makeFullPacket(workDir)
  mkdirSync(packet.out_dir, { recursive: true })
  writeFileSync(join(packet.out_dir, lensIssuesFileName('reader')), '[]', 'utf-8')
  writeFileSync(join(packet.out_dir, lensIssuesFileName('editor')), '[]', 'utf-8')
  writeFileSync(join(packet.out_dir, lensIssuesFileName('continuity')), JSON.stringify([
    { lens: 'continuity', severity: 'S2', category: 'ledger', location: '第30段', evidence: ['无推进'], issue: '账本造假', fix: '补动作' },
  ]), 'utf-8')
  const collected = collectReviewIssues({ packet })
  const text = renderReviewVerdict(collected)

  expect(text).toContain('账本核对阻断')
  expect(text).toContain('账本造假')
  expect(text).toContain('override')
  expect(readReviewVerdict(workDir).approved).toBe(false) // 有阻断，模板占位不算裁决
  rmSync(workDir, { recursive: true, force: true })
})

test('writeReviewVerdict + readReviewVerdict: 默认未裁决；作者写 verdict: 通过 后放行', () => {
  const workDir = mkdtempSync(join(tmpdir(), 'review-run-'))
  const packet = makeFullPacket(workDir)
  mkdirSync(packet.out_dir, { recursive: true })
  for (const lens of ['reader', 'editor', 'continuity'] as ReviewLens[]) {
    writeFileSync(join(packet.out_dir, lensIssuesFileName(lens)), '[]', 'utf-8')
  }
  const collected = collectReviewIssues({ packet })
  const path = writeReviewVerdict(workDir, collected)

  // 默认未裁决（三审通过但作者还没拍板）
  expect(readReviewVerdict(workDir).approved).toBe(false)

  // 模板里有占位 verdict（不会误判为已裁决）
  const templateText = readFileSync(path, 'utf-8')
  expect(templateText).toContain('verdict: <') // 占位形式
  expect(readReviewVerdict(workDir).approved).toBe(false) // 占位不算裁决

  // 作者拍板（必须带 marker，否则误命中模板）
  const text = readFileSync(path, 'utf-8')
  writeFileSync(path, text + `\n${REVIEW_VERDICT_MARKER} verdict: 通过\n`, 'utf-8')
  expect(readReviewVerdict(workDir).approved).toBe(true)
  expect(readReviewVerdict(workDir).hasOverride).toBe(false)

  // override 裁决
  writeFileSync(path, text + `\n${REVIEW_VERDICT_MARKER} verdict: 通过\n${REVIEW_VERDICT_MARKER} override: 账本项已人工核对\n`, 'utf-8')
  const overriden = readReviewVerdict(workDir)
  expect(overriden.approved).toBe(true)
  expect(overriden.hasOverride).toBe(true)
  expect(overriden.overrideReason).toContain('人工核对')

  rmSync(workDir, { recursive: true, force: true })
})

test('formatReviewPacket: 执行包含 issues 回写路径与各视角账本清单', () => {
  const workDir = mkdtempSync(join(tmpdir(), 'review-run-'))
  const built = buildReviewPacket({
    checkReport: reportWithLedger,
    body: '正文。',
    chapter: 12,
    workDir,
    capabilities: { parallel_subagents: true, multiple_calls: true },
    remaining_calls: 8,
    high_risk: false,
  })
  if (!built.ok) throw new Error('build failed')
  const text = formatReviewPacket(built.packet)
  expect(text).toContain('满审')
  expect(text).toContain('预计调用：3 次')
  expect(text).toContain('issues 回写目录')
  expect(text).toContain('伏笔-031')
  expect(text).toContain('clwriting review collect')
  rmSync(workDir, { recursive: true, force: true })
})

test('formatReviewPacket: 合审档位提示回写 issues-combined.json', () => {
  const workDir = mkdtempSync(join(tmpdir(), 'review-run-'))
  const built = buildReviewPacket({
    checkReport: reportWithLedger,
    body: '正文。',
    chapter: 5,
    workDir,
    capabilities: { parallel_subagents: true, multiple_calls: true },
    remaining_calls: 1,
    high_risk: false,
  })
  if (!built.ok) throw new Error('build failed')
  const text = formatReviewPacket(built.packet)
  expect(text).toContain(`回写 ${COMBINED_ISSUES_FILE}`)
  expect(text).not.toContain('回写 issues-continuity.json')
  rmSync(workDir, { recursive: true, force: true })
})
