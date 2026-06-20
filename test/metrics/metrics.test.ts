import { test, expect, vi } from 'vitest'
import { execSync } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  appendMetric,
  readMetrics,
  metricsPath,
  trimMetricsAfter,
  type MetricRecord,
} from '../../src/metrics/ledger.js'
import { collectMetrics } from '../../src/metrics/collect.js'
import { aggregateMetrics, formatMetricsReport } from '../../src/metrics/report.js'
import { DEFAULT_CONFIG } from '../../src/format/yaml.js'
import { writeBookConfig } from '../../src/format/yaml.js'
import { recordAiCall } from '../../src/ai/calls.js'
import {
  buildReviewPacket,
  writeReviewPacket,
  lensIssuesFileName,
  collectReviewIssues,
} from '../../src/review/run.js'
import { doConfirm } from '../../src/gate/confirm.js'
import { doFinalize } from '../../src/finalize/commit.js'
import { createAllTables } from '../../src/cache/schema.js'
import { rebuild } from '../../src/cache/rebuild.js'
import type { BookConfig, ChapterMeta } from '../../src/format/types.js'
import type { ReviewExecutionPacket } from '../../src/review/run.js'

// ── ledger.ts ─────────────────────────────────────

function sampleRecord(overrides: Partial<MetricRecord> = {}): MetricRecord {
  return {
    kind: 'long',
    num: 1,
    title: '第一章',
    words: 3000,
    at: '2026-06-20T00:00:00.000Z',
    calls: { outline: 1, draft: 1, review: 3, total: 5, limit: 8 },
    tokens: null,
    review: {
      tier: 'full',
      downgrade: false,
      downgrade_reason: null,
      blockers: 0,
      warnings: 2,
      invalid: 0,
      lenses: ['reader', 'editor', 'continuity'],
    },
    ...overrides,
  }
}

test('ledger: append + read 往返一致', () => {
  const root = mkdtempSync(join(tmpdir(), 'metrics-ledger-'))
  appendMetric(root, sampleRecord({ num: 1 }))
  appendMetric(root, sampleRecord({ num: 2, title: '第二章' }))
  const records = readMetrics(root)
  expect(records).toHaveLength(2)
  expect(records[0]!.num).toBe(1)
  expect(records[1]!.title).toBe('第二章')
  rmSync(root, { recursive: true, force: true })
})

test('ledger: 文件不存在 → 空数组（友好，不崩）', () => {
  const root = mkdtempSync(join(tmpdir(), 'metrics-ledger-'))
  expect(readMetrics(root)).toEqual([])
  rmSync(root, { recursive: true, force: true })
})

test('ledger: 坏行跳过，好行正常返回（容错）', () => {
  const root = mkdtempSync(join(tmpdir(), 'metrics-ledger-'))
  mkdirSync(join(root, '.cache'), { recursive: true })
  // 手写：一行好 + 一行坏 + 一行好
  const fp = metricsPath(root)
  const good = JSON.stringify(sampleRecord({ num: 1 }))
  const bad = '{not valid json'
  const good2 = JSON.stringify(sampleRecord({ num: 2 }))
  writeFileSync(fp, `${good}\n${bad}\n${good2}\n`, 'utf-8')
  const records = readMetrics(root)
  expect(records).toHaveLength(2)
  expect(records.map((r) => r.num)).toEqual([1, 2])
  rmSync(root, { recursive: true, force: true })
})

test('ledger: 缺关键字段的记录被丢弃（强类型校验）', () => {
  const root = mkdtempSync(join(tmpdir(), 'metrics-ledger-'))
  mkdirSync(join(root, '.cache'), { recursive: true })
  const fp = metricsPath(root)
  const noCalls = JSON.stringify({ kind: 'long', num: 1, title: 'x', words: 1, at: 't', tokens: null, review: null })
  const badKind = JSON.stringify({ ...sampleRecord(), kind: 'bad' })
  const ok = JSON.stringify(sampleRecord({ num: 5 }))
  writeFileSync(fp, `${noCalls}\n${badKind}\n${ok}\n`, 'utf-8')
  expect(readMetrics(root)).toHaveLength(1)
  expect(readMetrics(root)[0]!.num).toBe(5)
  rmSync(root, { recursive: true, force: true })
})

test('ledger: 回滚裁剪只删除同轨目标之后的指标', () => {
  const root = mkdtempSync(join(tmpdir(), 'metrics-ledger-'))
  appendMetric(root, sampleRecord({ kind: 'long', num: 1 }))
  appendMetric(root, sampleRecord({ kind: 'long', num: 2 }))
  appendMetric(root, sampleRecord({ kind: 'long', num: 3 }))
  appendMetric(root, sampleRecord({ kind: 'short', num: 1, title: '短篇一' }))

  const trimmed = trimMetricsAfter(root, 'long', 2)
  const records = readMetrics(root)
  expect(trimmed.removed).toBe(1)
  expect(records.map((r) => `${r.kind}:${r.num}`)).toEqual(['long:1', 'long:2', 'short:1'])
  rmSync(root, { recursive: true, force: true })
})

// ── collect.ts ────────────────────────────────────

const config: BookConfig = { ...DEFAULT_CONFIG, budget: { ...DEFAULT_CONFIG.budget, calls_per_chapter: 8 } }

test('collect: calls 按 step 分组（review + review-combined 归 review），total=used', () => {
  const workDir = mkdtempSync(join(tmpdir(), 'metrics-collect-'))
  recordAiCall({ workDir, chapter: 1, config, step: 'outline', at: 't1' })
  recordAiCall({ workDir, chapter: 1, config, step: 'draft', at: 't2' })
  recordAiCall({ workDir, chapter: 1, config, step: 'review', at: 't3' })
  recordAiCall({ workDir, chapter: 1, config, step: 'review-combined', at: 't4' })
  const root = mkdtempSync(join(tmpdir(), 'metrics-collect-'))
  const rec = collectMetrics(root, workDir, { kind: 'long', num: 1, title: '一', body: '正文', config })
  expect(rec.calls.outline).toBe(1)
  expect(rec.calls.draft).toBe(1)
  expect(rec.calls.review).toBe(2) // review + review-combined 合并
  expect(rec.calls.total).toBe(4) // used
  expect(rec.calls.limit).toBe(8)
  expect(rec.review).toBeNull() // 无三审 packet
  rmSync(workDir, { recursive: true, force: true })
  rmSync(root, { recursive: true, force: true })
})

test('collect: 无调用记录 → calls 全 0', () => {
  const workDir = mkdtempSync(join(tmpdir(), 'metrics-collect-'))
  const root = mkdtempSync(join(tmpdir(), 'metrics-collect-'))
  const rec = collectMetrics(root, workDir, { kind: 'long', num: 1, title: '一', body: 'x', config })
  expect(rec.calls).toEqual({ outline: 0, draft: 0, review: 0, total: 0, limit: 8 })
  rmSync(workDir, { recursive: true, force: true })
  rmSync(root, { recursive: true, force: true })
})

test('collect: words 现算（countWords 去 markdown 标记按字符计）', () => {
  const workDir = mkdtempSync(join(tmpdir(), 'metrics-collect-'))
  const root = mkdtempSync(join(tmpdir(), 'metrics-collect-'))
  const rec = collectMetrics(root, workDir, { kind: 'long', num: 1, title: '一', body: '北境的雪', config })
  expect(rec.words).toBe(4) // 4 个汉字字符
  rmSync(workDir, { recursive: true, force: true })
  rmSync(root, { recursive: true, force: true })
})

test('collect: tokens 有则求和（entries 部分带 token 仍出真值）', () => {
  const workDir = mkdtempSync(join(tmpdir(), 'metrics-collect-'))
  const root = mkdtempSync(join(tmpdir(), 'metrics-collect-'))
  recordAiCall({ workDir, chapter: 1, config, step: 'outline', tokens: 1000, at: 't1' })
  recordAiCall({ workDir, chapter: 1, config, step: 'draft', calls: 2, tokens: 3000, at: 't2' })
  recordAiCall({ workDir, chapter: 1, config, step: 'review', calls: 3, at: 't3' }) // 不带 tokens
  const rec = collectMetrics(root, workDir, { kind: 'long', num: 1, title: '一', body: '正文', config })
  expect(rec.tokens).toBe(4000) // 1000 + 3000；review 那条缺省不影响求和
  rmSync(workDir, { recursive: true, force: true })
  rmSync(root, { recursive: true, force: true })
})

test('collect: 全部 entry 无 tokens → tokens 为 null（诚实降级）', () => {
  const workDir = mkdtempSync(join(tmpdir(), 'metrics-collect-'))
  const root = mkdtempSync(join(tmpdir(), 'metrics-collect-'))
  recordAiCall({ workDir, chapter: 1, config, step: 'outline', at: 't1' })
  recordAiCall({ workDir, chapter: 1, config, step: 'draft', at: 't2' })
  const rec = collectMetrics(root, workDir, { kind: 'long', num: 1, title: '一', body: '正文', config })
  expect(rec.tokens).toBeNull()
  rmSync(workDir, { recursive: true, force: true })
  rmSync(root, { recursive: true, force: true })
})

test('collect: 三审 packet 回收 → review 字段含 tier/blockers/warnings/lenses', () => {
  const workDir = mkdtempSync(join(tmpdir(), 'metrics-collect-'))
  // 造满审 packet 并写盘
  const built = buildReviewPacket({
    checkReport: { sections: [], byproducts: { leadChanges: [] } },
    body: '正文。',
    chapter: 1,
    workDir,
    capabilities: { parallel_subagents: true, multiple_calls: true },
    remaining_calls: 8,
    high_risk: false,
  })
  if (!built.ok) throw new Error('packet build failed')
  writeReviewPacket(built.packet)
  const outDir = built.packet.out_dir
  mkdirSync(outDir, { recursive: true })
  // reader/editor 无问题，continuity 有 1 个 warning（非阻断）
  writeFileSync(join(outDir, lensIssuesFileName('reader')), '[]', 'utf-8')
  writeFileSync(join(outDir, lensIssuesFileName('editor')), '[]', 'utf-8')
  const contIssue = [{ lens: 'continuity', severity: 'S3', category: 'consistency', location: 'p10', evidence: ['证据'], issue: '小问题', fix: '改' }]
  writeFileSync(join(outDir, lensIssuesFileName('continuity')), JSON.stringify(contIssue), 'utf-8')

  const root = mkdtempSync(join(tmpdir(), 'metrics-collect-'))
  const rec = collectMetrics(root, workDir, { kind: 'long', num: 1, title: '一', body: '正文。', config })
  expect(rec.review).not.toBeNull()
  expect(rec.review!.tier).toBe('full')
  expect(rec.review!.downgrade).toBe(false)
  expect(rec.review!.warnings).toBe(1)
  expect(rec.review!.blockers).toBe(0)
  expect(rec.review!.lenses).toEqual(['reader', 'editor', 'continuity'])
  rmSync(workDir, { recursive: true, force: true })
  rmSync(root, { recursive: true, force: true })
})

test('collect: 三审缺视角 → review=null，不计入有效满审', () => {
  const workDir = mkdtempSync(join(tmpdir(), 'metrics-collect-'))
  const built = buildReviewPacket({
    checkReport: { sections: [], byproducts: { leadChanges: [] } },
    body: '正文。',
    chapter: 1,
    workDir,
    capabilities: { parallel_subagents: true, multiple_calls: true },
    remaining_calls: 8,
    high_risk: false,
  })
  if (!built.ok) throw new Error('packet build failed')
  writeReviewPacket(built.packet)
  const outDir = built.packet.out_dir
  mkdirSync(outDir, { recursive: true })
  writeFileSync(join(outDir, lensIssuesFileName('reader')), '[]', 'utf-8')
  writeFileSync(join(outDir, lensIssuesFileName('editor')), '[]', 'utf-8')

  const root = mkdtempSync(join(tmpdir(), 'metrics-collect-'))
  const rec = collectMetrics(root, workDir, { kind: 'long', num: 1, title: '一', body: '正文。', config })
  expect(rec.review).toBeNull()
  rmSync(workDir, { recursive: true, force: true })
  rmSync(root, { recursive: true, force: true })
})

test('collect: 三审 issues JSON 损坏 → review=null，不污染审查指标', () => {
  const workDir = mkdtempSync(join(tmpdir(), 'metrics-collect-'))
  const built = buildReviewPacket({
    checkReport: { sections: [], byproducts: { leadChanges: [] } },
    body: '正文。',
    chapter: 1,
    workDir,
    capabilities: { parallel_subagents: true, multiple_calls: true },
    remaining_calls: 8,
    high_risk: false,
  })
  if (!built.ok) throw new Error('packet build failed')
  writeReviewPacket(built.packet)
  const outDir = built.packet.out_dir
  mkdirSync(outDir, { recursive: true })
  writeFileSync(join(outDir, lensIssuesFileName('reader')), '[]', 'utf-8')
  writeFileSync(join(outDir, lensIssuesFileName('editor')), '[]', 'utf-8')
  writeFileSync(join(outDir, lensIssuesFileName('continuity')), '{not json', 'utf-8')

  const root = mkdtempSync(join(tmpdir(), 'metrics-collect-'))
  const rec = collectMetrics(root, workDir, { kind: 'long', num: 1, title: '一', body: '正文。', config })
  expect(rec.review).toBeNull()
  rmSync(workDir, { recursive: true, force: true })
  rmSync(root, { recursive: true, force: true })
})

test('collect: 三审产物损坏 → review=null 且 console.warn 留痕（#4 区分损坏与缺失）', () => {
  const workDir = mkdtempSync(join(tmpdir(), 'metrics-collect-'))
  const built = buildReviewPacket({
    checkReport: { sections: [], byproducts: { leadChanges: [] } },
    body: '正文。',
    chapter: 1,
    workDir,
    capabilities: { parallel_subagents: true, multiple_calls: true },
    remaining_calls: 8,
    high_risk: false,
  })
  if (!built.ok) throw new Error('packet build failed')
  writeReviewPacket(built.packet)
  const outDir = built.packet.out_dir
  mkdirSync(outDir, { recursive: true })
  writeFileSync(join(outDir, lensIssuesFileName('reader')), '[]', 'utf-8')
  writeFileSync(join(outDir, lensIssuesFileName('editor')), '[]', 'utf-8')
  // continuity 文件损坏 → collectReviewIssues 不 ok → 应 warn
  writeFileSync(join(outDir, lensIssuesFileName('continuity')), '{not json', 'utf-8')

  const root = mkdtempSync(join(tmpdir(), 'metrics-collect-'))
  const warns: string[] = []
  const spy = vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => { warns.push(args.join(' ')) })
  try {
    const rec = collectMetrics(root, workDir, { kind: 'long', num: 1, title: '一', body: '正文。', config })
    expect(rec.review).toBeNull() // 仍不阻断，诚实记 null
    expect(warns.join('\n')).toMatch(/三审产物异常/) // stderr 留痕（损坏可见，不被静默）
    expect(warns.join('\n')).toMatch(/损坏/) // 带上具体损坏信息
  } finally {
    spy.mockRestore()
    rmSync(workDir, { recursive: true, force: true })
    rmSync(root, { recursive: true, force: true })
  }
})

test('collect: 三审缺视角（非损坏）→ review=null 且 warn 留痕（缺视角与损坏同样留痕，便于排查）', () => {
  const workDir = mkdtempSync(join(tmpdir(), 'metrics-collect-'))
  const built = buildReviewPacket({
    checkReport: { sections: [], byproducts: { leadChanges: [] } },
    body: '正文。',
    chapter: 1,
    workDir,
    capabilities: { parallel_subagents: true, multiple_calls: true },
    remaining_calls: 8,
    high_risk: false,
  })
  if (!built.ok) throw new Error('packet build failed')
  writeReviewPacket(built.packet)
  const outDir = built.packet.out_dir
  mkdirSync(outDir, { recursive: true })
  writeFileSync(join(outDir, lensIssuesFileName('reader')), '[]', 'utf-8')
  writeFileSync(join(outDir, lensIssuesFileName('editor')), '[]', 'utf-8')
  // 注意：continuity 文件不存在 → collectReviewIssues 因缺视角返回 ok:false
  // 但属「产物不完整」非「损坏」。这里验证：只要是不 ok 都 warn（缺视角也留痕，便于排查）。

  const root = mkdtempSync(join(tmpdir(), 'metrics-collect-'))
  const warns: string[] = []
  const spy = vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => { warns.push(args.join(' ')) })
  try {
    const rec = collectMetrics(root, workDir, { kind: 'long', num: 1, title: '一', body: '正文。', config })
    expect(rec.review).toBeNull()
    expect(warns.join('\n')).toMatch(/三审产物异常/) // 缺视角也留痕
  } finally {
    spy.mockRestore()
    rmSync(workDir, { recursive: true, force: true })
    rmSync(root, { recursive: true, force: true })
  }
})

test('collect: 合审档位 → downgrade=true + downgrade_reason', () => {
  const workDir = mkdtempSync(join(tmpdir(), 'metrics-collect-'))
  const built = buildReviewPacket({
    checkReport: { sections: [], byproducts: { leadChanges: [] } },
    body: '正文。',
    chapter: 1,
    workDir,
    capabilities: { parallel_subagents: false, multiple_calls: false }, // 降合审
    remaining_calls: 1,
    high_risk: false,
  })
  if (!built.ok) throw new Error('packet build failed')
  writeReviewPacket(built.packet)
  mkdirSync(built.packet.out_dir, { recursive: true })
  writeFileSync(join(built.packet.out_dir, 'issues-combined.json'), '[]', 'utf-8')

  const root = mkdtempSync(join(tmpdir(), 'metrics-collect-'))
  const rec = collectMetrics(root, workDir, { kind: 'long', num: 1, title: '一', body: 'x', config })
  expect(rec.review!.tier).toBe('combined')
  expect(rec.review!.downgrade).toBe(true)
  expect(rec.review!.downgrade_reason).not.toBeNull()
  rmSync(workDir, { recursive: true, force: true })
  rmSync(root, { recursive: true, force: true })
})

// ── report.ts ─────────────────────────────────────

test('report: 空记录 → 友好提示', () => {
  const report = aggregateMetrics([])
  expect(formatMetricsReport(report)).toContain('尚无定稿指标')
})

test('report: 聚合平均调用 / 超限章次 / 满审率 / 降级率正确', () => {
  const records: MetricRecord[] = [
    sampleRecord({ num: 1, calls: { outline: 1, draft: 1, review: 3, total: 5, limit: 8 } }),
    sampleRecord({ num: 2, calls: { outline: 1, draft: 1, review: 3, total: 9, limit: 8 } }), // 超限
    sampleRecord({
      num: 3,
      calls: { outline: 1, draft: 1, review: 1, total: 3, limit: 8 },
      review: { tier: 'combined', downgrade: true, downgrade_reason: '调用不足', blockers: 1, warnings: 0, invalid: 0, lenses: ['reader'] },
    }),
  ]
  const report = aggregateMetrics(records)
  expect(report.count).toBe(3)
  expect(report.cost.avgCalls).toBeCloseTo((5 + 9 + 3) / 3, 5) // 5.667
  expect(report.cost.overLimitChapters).toBe(1) // 第2章 9>8
  expect(report.review.reviewedCount).toBe(3)
  expect(report.review.fullRate).toBeCloseTo(2 / 3, 5) // 第1/2章满审
  expect(report.review.downgradeRate).toBeCloseTo(1 / 3, 5) // 第3章降级
  expect(report.review.avgBlockers).toBeCloseTo(1 / 3, 5)
  expect(report.review.topDowngradeReasons[0]).toEqual({ reason: '调用不足', n: 1 })
})

test('report: --last=N 只取最近 N 条', () => {
  const records = [5, 1, 4, 2, 3].map((n) => sampleRecord({ num: n }))
  const report = aggregateMetrics(records, { last: 2 })
  expect(report.count).toBe(2)
  expect(report.range).toEqual({ from: 4, to: 5 })
})

test('report: review 全 null（短篇合审）→ 审查段诚实降级', () => {
  const records = [sampleRecord({ num: 1, review: null }), sampleRecord({ num: 2, review: null })]
  const report = aggregateMetrics(records)
  expect(report.review.reviewedCount).toBe(0)
  expect(formatMetricsReport(report)).toContain('无三审记录')
})

test('report: token 维度三态备注', () => {
  // 全 null → 仅调用次数粒度
  const noneReport = aggregateMetrics([sampleRecord({ num: 1, tokens: null }), sampleRecord({ num: 2, tokens: null })])
  expect(noneReport.cost.tokensNote).toContain('仅调用次数粒度')

  // 全有 → 平均 token/章
  const allReport = aggregateMetrics([
    sampleRecord({ num: 1, tokens: 4000 }),
    sampleRecord({ num: 2, tokens: 6000 }),
  ])
  expect(allReport.cost.tokensNote).toContain('平均 5000 token/章')

  // 部分 → 标注覆盖度
  const partialReport = aggregateMetrics([
    sampleRecord({ num: 1, tokens: 3000 }),
    sampleRecord({ num: 2, tokens: null }),
  ])
  expect(partialReport.cost.tokensNote).toContain('部分 token 采集')
  expect(partialReport.cost.tokensNote).toContain('1/2')
})

// ── 落账点：doFinalize 后 metrics.jsonl 落一行 ─────

/** 造一个完整 git 书仓库（用于落账点测试） */
function makeGitBook(): string {
  const root = mkdtempSync(join(tmpdir(), 'metrics-finalize-'))
  execSync('git init', { cwd: root, stdio: 'pipe' })
  execSync('git config user.email test@test.com', { cwd: root, stdio: 'pipe' })
  execSync('git config user.name test', { cwd: root, stdio: 'pipe' })
  writeBookConfig(join(root, 'book.yaml'), config)
  mkdirSync(join(root, '大纲', '伏笔'), { recursive: true })
  mkdirSync(join(root, '定稿', '正文'), { recursive: true })
  mkdirSync(join(root, '定稿', '摘要', '章摘要'), { recursive: true })
  mkdirSync(join(root, '工作区'), { recursive: true })
  mkdirSync(join(root, '.cache'), { recursive: true })
  const db = new DatabaseSync(join(root, '.cache', 'index.db'))
  createAllTables(db)
  db.close()
  execSync('git add -A && git commit -m "init"', { cwd: root, stdio: 'pipe' })
  return root
}

test('落账点: doFinalize 成功 → metrics.jsonl 落一行，calls 值正确', () => {
  const root = makeGitBook()
  const db = new DatabaseSync(join(root, '.cache', 'index.db'))
  const workDir = join(root, '工作区')
  const outline = join(workDir, '细纲.md')
  writeFileSync(outline, '细纲', 'utf-8')
  doConfirm(workDir, 1, outline, 'manual', config)
  writeFileSync(join(workDir, '审稿.md'), '通过', 'utf-8')
  recordAiCall({ workDir, chapter: 1, config, step: 'outline', at: 't' })
  recordAiCall({ workDir, chapter: 1, config, step: 'draft', at: 't' })

  const ch: ChapterMeta = { 章号: 1, 标题: '第一章', 钩子类型: '悬念钩', 钩子强弱: '强', 情绪定位: '铺垫' }
  const r = doFinalize({
    bookRoot: root, workDir, outlinePath: outline, db, config,
    chapter: ch, body: '北境雪落无声。', fileName: '1-第一章.md', hasReviewVerdict: true,
  })
  expect(r.ok).toBe(true)

  // 落账验证
  expect(existsSync(metricsPath(root))).toBe(true)
  const records = readMetrics(root)
  expect(records).toHaveLength(1)
  expect(records[0]!.num).toBe(1)
  expect(records[0]!.title).toBe('第一章')
  expect(records[0]!.calls.outline).toBe(1)
  expect(records[0]!.calls.draft).toBe(1)
  expect(records[0]!.calls.total).toBe(2)
  expect(records[0]!.calls.limit).toBe(8)
  expect(records[0]!.words).toBeGreaterThan(0)
  expect(records[0]!.review).toBeNull() // 无三审
  db.close()
  rmSync(root, { recursive: true, force: true })
})

test('落账点: 采集抛错不阻断定稿（注入损坏三审，finalize 仍成功）', () => {
  const root = makeGitBook()
  const db = new DatabaseSync(join(root, '.cache', 'index.db'))
  const workDir = join(root, '工作区')
  const outline = join(workDir, '细纲.md')
  writeFileSync(outline, '细纲', 'utf-8')
  doConfirm(workDir, 1, outline, 'manual', config)
  writeFileSync(join(workDir, '审稿.md'), '通过', 'utf-8')
  recordAiCall({ workDir, chapter: 1, config, step: 'draft', at: 't' })
  // 注入损坏的 packet.json（collectReview 会读它，但 collectAndAppend try/catch 兜住）
  mkdirSync(join(workDir, '三审'), { recursive: true })
  writeFileSync(join(workDir, '三审', 'packet.json'), '{ 坏的 json', 'utf-8')

  const ch: ChapterMeta = { 章号: 1, 标题: '第一章', 钩子类型: '悬念钩', 钩子强弱: '强', 情绪定位: '铺垫' }
  const r = doFinalize({
    bookRoot: root, workDir, outlinePath: outline, db, config,
    chapter: ch, body: '正文。', fileName: '1-第一章.md', hasReviewVerdict: true,
  })
  expect(r.ok).toBe(true) // 定稿不受影响
  db.close()
  rmSync(root, { recursive: true, force: true })
})

// ── rebuild 守护（#6）──────────────────────────────

test('守护: 删 index.db rebuild 后 metrics.jsonl 不丢（rebuild 不碰 .cache 其它文件）', () => {
  const root = mkdtempSync(join(tmpdir(), 'metrics-rebuild-'))
  mkdirSync(join(root, '.cache'), { recursive: true })
  appendMetric(root, sampleRecord({ num: 1 }))
  appendMetric(root, sampleRecord({ num: 2 }))
  expect(readMetrics(root)).toHaveLength(2)

  // rebuild index.db（模拟 finalize 后的重建）
  writeBookConfig(join(root, 'book.yaml'), config)
  rebuild(root, join(root, '.cache', 'index.db'))

  // metrics.jsonl 仍在、内容不丢
  expect(existsSync(metricsPath(root))).toBe(true)
  expect(readMetrics(root)).toHaveLength(2)
  rmSync(root, { recursive: true, force: true })
})

// ── auto 批量连写：每章各落一行（出口验收 §6 块A 第3条）──

/** 跑一次完整定稿（doConfirm + doFinalize），返回是否成功 */
function finalizeOneChapter(root: string, num: number, title: string): boolean {
  const db = new DatabaseSync(join(root, '.cache', 'index.db'))
  try {
    const workDir = join(root, '工作区')
    const outline = join(workDir, '细纲.md')
    writeFileSync(outline, `第${num}章细纲`, 'utf-8')
    doConfirm(workDir, num, outline, 'manual', config)
    writeFileSync(join(workDir, '审稿.md'), '通过', 'utf-8')
    recordAiCall({ workDir, chapter: num, config, step: 'draft', at: `t${num}` })
    const ch: ChapterMeta = { 章号: num, 标题: title, 钩子类型: '悬念钩', 钩子强弱: '强', 情绪定位: '铺垫' }
    const r = doFinalize({
      bookRoot: root, workDir, outlinePath: outline, db, config,
      chapter: ch, body: `第${num}章正文。`, fileName: `${num}-${title}.md`, hasReviewVerdict: true,
    })
    return r.ok
  } finally {
    db.close()
  }
}

test('auto批量: 连写 3 章各落一行，calls 按章独立正确（落账点覆盖批量路径）', () => {
  const root = makeGitBook()
  expect(finalizeOneChapter(root, 1, '觉醒')).toBe(true)
  expect(finalizeOneChapter(root, 2, '风雪')).toBe(true)
  expect(finalizeOneChapter(root, 3, '北境')).toBe(true)

  const records = readMetrics(root)
  expect(records).toHaveLength(3)
  // 每章各一行，章号连续，calls.total 各自独立（每章各记 1 次 draft）
  expect(records.map((r) => r.num)).toEqual([1, 2, 3])
  expect(records.every((r) => r.calls.total === 1)).toBe(true)
  expect(records.map((r) => r.title)).toEqual(['觉醒', '风雪', '北境'])
  rmSync(root, { recursive: true, force: true })
})

// ── 短篇按篇落账（出口验收 §6 块A 第5条）──

const SHORT_CONFIG: BookConfig = { ...DEFAULT_CONFIG, kind: 'short', book: { title: '夜语集', genre: '悬疑' } }

/** 建短篇集仓库（git + kind:short + 篇/ + 工作区 + .cache） */
function makeShortBook(): string {
  const root = mkdtempSync(join(tmpdir(), 'metrics-short-'))
  execSync('git init', { cwd: root, stdio: 'pipe' })
  execSync('git config user.email t@t.com && git config user.name t && git config commit.gpgsign false', { cwd: root, stdio: 'pipe' })
  writeBookConfig(join(root, 'book.yaml'), SHORT_CONFIG)
  mkdirSync(join(root, '篇'), { recursive: true })
  mkdirSync(join(root, '工作区'), { recursive: true })
  mkdirSync(join(root, '.cache'), { recursive: true })
  const db = new DatabaseSync(join(root, '.cache', 'index.db'))
  createAllTables(db)
  db.close()
  execSync('git add -A && git commit -m init', { cwd: root, stdio: 'pipe' })
  return root
}

test('短篇落账: kind=short + num=篇号，落 篇/ 下后 metrics 落一行（落账点覆盖短篇路径）', () => {
  const root = makeShortBook()
  const db = new DatabaseSync(join(root, '.cache', 'index.db'))
  const workDir = join(root, '工作区')
  const outline = join(workDir, '细纲.md')
  writeFileSync(outline, '雪夜细纲', 'utf-8')
  doConfirm(workDir, 1, outline, 'manual', SHORT_CONFIG)
  writeFileSync(join(workDir, '审稿.md'), '通过', 'utf-8')
  recordAiCall({ workDir, chapter: 1, config: SHORT_CONFIG, step: 'draft', at: 't' })

  const ch: ChapterMeta = { 章号: 1, 标题: '雪夜', 钩子类型: '悬念钩', 钩子强弱: '强', 情绪定位: '转折' }
  const r = doFinalize({
    bookRoot: root, workDir, outlinePath: outline, db, config: SHORT_CONFIG,
    chapter: ch, body: '雪夜的正文。', fileName: '001-雪夜/正文.md', hasReviewVerdict: true, kind: 'short',
  })
  expect(r.ok).toBe(true)

  // 落账验证：kind=short、num=篇号=1
  const records = readMetrics(root)
  expect(records).toHaveLength(1)
  expect(records[0]!.kind).toBe('short')
  expect(records[0]!.num).toBe(1) // 篇号
  expect(records[0]!.title).toBe('雪夜')
  expect(records[0]!.calls.draft).toBe(1)
  db.close()
  rmSync(root, { recursive: true, force: true })
})
