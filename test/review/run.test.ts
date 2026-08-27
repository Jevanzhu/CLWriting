import { test, expect } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import {
  buildReviewPacket,
  collectReviewIssues,
  lensIssuesFileName,
  COMBINED_ISSUES_FILE,
  type ReviewExecutionPacket,
} from '../../src/review/run.js'
import type { CheckReport } from '../../src/check/types.js'
import type { ReviewIssue } from '../../src/review/contract.js'

// 账本变动清单（机检 byproducts → 设定校对账本核对项）
const reportWithLedger: CheckReport = {
  sections: [],
  byproducts: {
    leadChanges: [
      { leadId: '悬念-031', chapter: 12, verb: '推进', evidence: '他终于看见焦痕背后的掌印。' },
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
    hasWiring: true,
    hasShort: false,
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
  expect(continuity.ledger_checks[0]!.lead_id).toBe('悬念-031')
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
    hasWiring: true,
    hasShort: false,
  })
  expect(built.ok).toBe(true)
  if (!built.ok) return

  const { packet } = built
  expect(packet.tier).toBe('combined')
  expect(packet.planned_calls).toBe(1)
  expect(packet.packets).toHaveLength(1)
  // 合审单包仍带账本清单（不被降级稀释）
  expect(packet.packets[0]!.ledger_checks).toHaveLength(1)
  expect(packet.packets[0]!.ledger_checks[0]!.lead_id).toBe('悬念-031')
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
    hasWiring: true,
    hasShort: false,
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
    hasWiring: true,
    hasShort: false,
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
      issue: '账本 悬念-031 声明「推进」但正文证据不足，疑似账本造假。',
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

test('RB-KN-P2-8: issues 文件读取失败（并发删除/权限）→ 与 JSON 损坏分开记录原因', () => {
  const workDir = mkdtempSync(join(tmpdir(), 'review-run-'))
  const packet = makeFullPacket(workDir)
  mkdirSync(packet.out_dir, { recursive: true })
  // reader：占位目录 → readFileSync 抛 EISDIR（读取失败面）
  mkdirSync(join(packet.out_dir, lensIssuesFileName('reader')), { recursive: true })
  // editor：内容坏 → JSON 解析失败面
  writeFileSync(join(packet.out_dir, lensIssuesFileName('editor')), '{oops', 'utf-8')
  writeFileSync(join(packet.out_dir, lensIssuesFileName('continuity')), '[]', 'utf-8')

  const collected = collectReviewIssues({ packet })
  expect(collected.ok).toBe(false)
  const readFail = collected.bad_entries.find((b) => b.reason.includes('文件读取失败'))
  const jsonBad = collected.bad_entries.find((b) => b.reason.includes('JSON 损坏'))
  expect(readFail).toBeDefined() // 修复前：读取失败也被记成「JSON 损坏」
  expect(jsonBad).toBeDefined()
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
    hasWiring: true,
    hasShort: false,
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

// ── R61-13（第六十一轮）：draft_hash 一致性实装 ────────────────────────────────

test('R61-13: collect 校验 draft_hash——不符 → 审稿单不成立带原因；相符 → 正常回收', () => {
  const workDir = mkdtempSync(join(tmpdir(), 'review-r61-13-'))
  const draftPath = join(workDir, 'draft.md')
  writeFileSync(draftPath, '正文。', 'utf-8')
  const hash = createHash('sha256').update(readFileSync(draftPath)).digest('hex')

  const build = (dh?: string) => {
    const built = buildReviewPacket({
      checkReport: reportWithLedger,
      body: '正文。',
      chapter: 12,
      workDir,
      capabilities: { parallel_subagents: true, multiple_calls: true },
      remaining_calls: 8,
      high_risk: false,
      hasWiring: true,
      hasShort: false,
      draft_path: draftPath,
      ...(dh !== undefined ? { draft_hash: dh } : {}),
    })
    if (!built.ok) throw new Error('packet build failed')
    return built.packet
  }

  // 相符：三视角齐 → ok
  const okPacket = build(hash)
  mkdirSync(okPacket.out_dir, { recursive: true })
  writeFileSync(join(okPacket.out_dir, lensIssuesFileName('reader')), '[]', 'utf-8')
  writeFileSync(join(okPacket.out_dir, lensIssuesFileName('editor')), '[]', 'utf-8')
  writeFileSync(join(okPacket.out_dir, lensIssuesFileName('continuity')), '[]', 'utf-8')
  expect(collectReviewIssues({ packet: okPacket }).ok).toBe(true)

  // 不符（审阅期间草稿漂移）：即便三视角齐也判不成立
  const stalePacket = build('deadbeef')
  mkdirSync(stalePacket.out_dir, { recursive: true })
  writeFileSync(join(stalePacket.out_dir, lensIssuesFileName('reader')), '[]', 'utf-8')
  writeFileSync(join(stalePacket.out_dir, lensIssuesFileName('editor')), '[]', 'utf-8')
  writeFileSync(join(stalePacket.out_dir, lensIssuesFileName('continuity')), '[]', 'utf-8')
  const stale = collectReviewIssues({ packet: stalePacket })
  expect(stale.ok).toBe(false)
  expect(stale.bad_entries[0]!.reason).toContain('draft_hash')

  // 草稿被删（读失败与不符同判）
  rmSync(draftPath)
  const gone = collectReviewIssues({ packet: build(hash) })
  expect(gone.ok).toBe(false)
  expect(gone.bad_entries[0]!.reason).toContain('draft_hash')
  rmSync(workDir, { recursive: true, force: true })
})

// ── R63-4（十一轮）：采集失败注入阻断级 issue（假通过双侧防御·脚本侧） ────────────
// 修复前：stale/缺视角/坏条目路径空 issues 过 normalizeReviewResult 得 passed:true
//（空判据），端点照落信封、前端渲染「三审通过」——假通过持久化。

test('R63-4: draft_hash 不符（stale）→ 注入阻断「三审未完成」issue，normalized.passed 恒 false', () => {
  const workDir = mkdtempSync(join(tmpdir(), 'review-r63-4-stale-'))
  const draftPath = join(workDir, 'draft.md')
  writeFileSync(draftPath, '正文。', 'utf-8')

  const built = buildReviewPacket({
    checkReport: reportWithLedger,
    body: '正文。',
    chapter: 12,
    workDir,
    capabilities: { parallel_subagents: true, multiple_calls: true },
    remaining_calls: 8,
    high_risk: false,
    hasWiring: true,
    hasShort: false,
    draft_path: draftPath,
    draft_hash: 'deadbeef', // 与盘上草稿不符 → stale 路径
  })
  if (!built.ok) throw new Error('packet build failed')
  mkdirSync(built.packet.out_dir, { recursive: true })
  writeFileSync(join(built.packet.out_dir, lensIssuesFileName('reader')), '[]', 'utf-8')
  writeFileSync(join(built.packet.out_dir, lensIssuesFileName('editor')), '[]', 'utf-8')
  writeFileSync(join(built.packet.out_dir, lensIssuesFileName('continuity')), '[]', 'utf-8')

  const collected = collectReviewIssues({ packet: built.packet })
  expect(collected.ok).toBe(false)
  // 修复前：空 issues → passed:true（空判据假通过）
  expect(collected.normalized.passed).toBe(false)
  expect(collected.normalized.blockers).toHaveLength(1)
  expect(collected.normalized.blockers[0]!.issue).toContain('三审未完成')
  expect(collected.normalized.blockers[0]!.evidence.join('')).toContain('draft_hash')
  expect(collected.normalized.blockers[0]!.blocking).toBe(true)
  rmSync(workDir, { recursive: true, force: true })
})

test('R63-4: 缺视角/坏条目 → 注入阻断 issue 带原因清单，passed 恒 false（raw_issues 不混入）', () => {
  const workDir = mkdtempSync(join(tmpdir(), 'review-r63-4-missing-'))
  const packet = makeFullPacket(workDir)
  mkdirSync(packet.out_dir, { recursive: true })
  // reader 回写一条真实意见；editor 坏 JSON；continuity 缺失
  writeFileSync(
    join(packet.out_dir, lensIssuesFileName('reader')),
    JSON.stringify([{ lens: 'reader', severity: 'S4', category: 'pacing', location: '中段', evidence: ['节奏偏慢'], issue: '拖沓', fix: '压缩' }]),
    'utf-8',
  )
  writeFileSync(join(packet.out_dir, lensIssuesFileName('editor')), '{oops', 'utf-8')

  const collected = collectReviewIssues({ packet: packet })
  expect(collected.ok).toBe(false)
  expect(collected.normalized.passed).toBe(false)
  const injected = collected.normalized.blockers.find((i) => i.issue.includes('三审未完成'))
  expect(injected).toBeDefined()
  // 原因清单进 evidence：缺视角 + 坏条目都要可见
  const evidenceText = injected!.evidence.join('；')
  expect(evidenceText).toContain('缺视角')
  expect(evidenceText).toContain('continuity')
  expect(evidenceText).toContain('issues-editor.json')
  // raw_issues 保持宿主原产（只含 reader 的 1 条），注入项不混入
  expect(collected.raw_issues).toHaveLength(1)
  // 真实意见照常归一化（S4 非阻断 → warnings）
  expect(collected.normalized.warnings).toHaveLength(1)
  rmSync(workDir, { recursive: true, force: true })
})

// R62-34：ledger_check 如实——分包不带账本核对项 → 跳过（无布线/短篇形态）；
// 此前恒报「已跑」与实际执行面不符。meta 随 CollectedReview 透出（normalizeReviewResult 不带 meta）。
test('collectReviewIssues: ledger_check 如实（无账本核对分包 → 跳过；满审带账本 → 已跑）', () => {
  const workDir = mkdtempSync(join(tmpdir(), 'review-run-'))
  try {
    const packet: ReviewExecutionPacket = {
      chapter: 12,
      tier: 'sequential',
      requested_tier: 'full',
      fallback: '',
      lenses_run: ['reader'],
      planned_calls: 1,
      packets: [
        { lens: 'reader', title: '读者审', focus: ['沉浸感'], ledger_checks: [], output_contract: { json_only: true, evidence_required: true, no_score: true }, body: '正文。', chapter: 12 },
      ],
      out_dir: workDir,
    }
    mkdirSync(workDir, { recursive: true })
    writeFileSync(join(workDir, lensIssuesFileName('reader')), '[]', 'utf-8')
    const noLedger = collectReviewIssues({ packet })
    expect(noLedger.ok).toBe(true)
    expect(noLedger.meta.ledger_check).toBe('跳过')

    const full = makeFullPacket(workDir)
    mkdirSync(full.out_dir, { recursive: true })
    for (const lens of full.lenses_run) {
      writeFileSync(join(full.out_dir, lensIssuesFileName(lens)), '[]', 'utf-8')
    }
    const withLedger = collectReviewIssues({ packet: full })
    expect(withLedger.meta.ledger_check).toBe('已跑')
  } finally {
    rmSync(workDir, { recursive: true, force: true })
  }
})

test('R65-18（批 B）：evidence:[{}] 对象壳穿透判格式不符；字符串证据照常成立', () => {
  const workDir = mkdtempSync(join(tmpdir(), 'review-run-'))
  try {
    const packet = makeFullPacket(workDir)
    mkdirSync(packet.out_dir, { recursive: true })
    // continuity：一条 evidence 含对象项（修复前 String({})='[object Object]' 穿透空证据硬闸）、
    // 一条合法字符串证据；reader/editor 空回收
    writeFileSync(
      join(packet.out_dir, lensIssuesFileName('continuity')),
      JSON.stringify([
        {
          lens: 'continuity', severity: 'S2', category: 'logic', location: '第12章',
          evidence: [{ fake: '字段' }], issue: '对象壳证据', fix: 'x',
        },
        {
          lens: 'continuity', severity: 'S3', category: 'logic', location: '第12章',
          evidence: ['前文无铺垫的突击反转'], issue: '正常字符串证据', fix: '补铺垫',
        },
      ]),
      'utf-8',
    )
    writeFileSync(join(packet.out_dir, lensIssuesFileName('reader')), '[]', 'utf-8')
    writeFileSync(join(packet.out_dir, lensIssuesFileName('editor')), '[]', 'utf-8')

    const collected = collectReviewIssues({ packet })
    // 对象壳条目 → bad_entries（非静默通过；reason 截 80 字符，按前缀匹配）
    expect(collected.bad_entries.some((b) => b.reason.startsWith('issue 格式不符'))).toBe(true)
    // 双向：合法字符串证据条目 → 正常归一化收录（blockers/warnings 按严重级分桶）；对象壳不出现
    const allNormalized = [...collected.normalized.blockers, ...collected.normalized.warnings, ...collected.normalized.invalid_issues]
    expect(allNormalized.some((i) => i.issue === '正常字符串证据')).toBe(true)
    expect(allNormalized.some((i) => i.issue === '对象壳证据')).toBe(false)
    // 收录数口径：3 回收、0 缺失
    expect(collected.missing_lenses).toHaveLength(0)
  } finally {
    rmSync(workDir, { recursive: true, force: true })
  }
})
