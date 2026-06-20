/**
 * 指标账读写 —— 体检报告「成本/审查」维度的落账载体（指标方案 §2/§3.2）。
 *
 * 每章/篇定稿时 append 一行 JSON 到 `.cache/metrics.jsonl`（机器域、不进 git），
 * 与 health-check.json 同款。rebuild 只动 index.db 不碰 .cache 其它文件，
 * 故账本 rebuild 不丢（见 ledger.test.ts 守护测试）。
 *
 * 容错：逐行 parse，坏行跳过不崩（采集/读取均不阻断主流程）。
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { BookConfig } from '../format/types.js'

/** 调用次数分解（按 AI 步骤） */
export interface CallBreakdown {
  outline: number
  draft: number
  review: number
  total: number
  limit: number
}

/** 审查档位/降级/问题计数（无三审产物时整段为 null，诚实降级） */
export interface ReviewMetrics {
  tier: 'full' | 'sequential' | 'combined'
  downgrade: boolean
  downgrade_reason: string | null
  blockers: number
  warnings: number
  invalid: number
  lenses: string[]
}

/** 一条定稿指标记录（metrics.jsonl 的一行） */
export interface MetricRecord {
  kind: 'long' | 'short'
  num: number
  title: string
  words: number
  at: string // ISO 时间戳
  calls: CallBreakdown
  /** 预留：真实 token 未采集，本期恒 null（OQ1） */
  tokens: number | null
  /** 审查指标；无三审产物（短篇合审/未三审/旧工作区）时为 null，诚实降级 */
  review: ReviewMetrics | null
}

/** `.cache/metrics.jsonl` 路径 */
export function metricsPath(bookRoot: string): string {
  return join(bookRoot, '.cache', 'metrics.jsonl')
}

/**
 * 追加一条定稿指标记录（定稿落账点调用，commit 成功后、clearWorkDir 前）。
 * 逐行 JSON：每行一条，坏行不影响其它行。失败抛出由调用方 try/catch（指标不阻断定稿）。
 */
export function appendMetric(bookRoot: string, rec: MetricRecord): void {
  const fp = metricsPath(bookRoot)
  mkdirSync(dirname(fp), { recursive: true })
  appendFileSync(fp, JSON.stringify(rec) + '\n', 'utf-8')
}

/**
 * 读取全部指标记录。逐行 parse，坏行跳过（容错不崩）。
 * 文件不存在 → 空数组（尚无定稿指标）。
 */
export function readMetrics(bookRoot: string): MetricRecord[] {
  const fp = metricsPath(bookRoot)
  if (!existsSync(fp)) return []
  let content: string
  try {
    content = readFileSync(fp, 'utf-8')
  } catch {
    return []
  }
  const records: MetricRecord[] = []
  for (const line of content.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    try {
      const parsed = JSON.parse(trimmed) as unknown
      const rec = coerceRecord(parsed)
      if (rec) records.push(rec)
    } catch {
      // 坏行跳过，不崩
    }
  }
  return records
}

/** 松散对象 → MetricRecord 强类型校验；缺关键字段返回 null（坏行丢弃） */
function coerceRecord(raw: unknown): MetricRecord | null {
  if (typeof raw !== 'object' || raw === null) return null
  const o = raw as Record<string, unknown>
  const kind = o['kind']
  if (kind !== 'long' && kind !== 'short') return null
  const num = Number(o['num'])
  const words = Number(o['words'])
  const at = String(o['at'] ?? '')
  const title = String(o['title'] ?? '')
  if (!Number.isSafeInteger(num) || num < 1) return null
  if (!Number.isFinite(words) || words < 0) return null

  const callsRaw = o['calls']
  const calls = callsRaw && typeof callsRaw === 'object' ? coerceCalls(callsRaw as Record<string, unknown>) : null
  if (!calls) return null

  const tokensRaw = o['tokens']
  const tokens = typeof tokensRaw === 'number' && Number.isFinite(tokensRaw) ? tokensRaw : null

  const reviewRaw = o['review']
  const review = reviewRaw === null ? null : reviewRaw && typeof reviewRaw === 'object' ? coerceReview(reviewRaw as Record<string, unknown>) : null

  return {
    kind,
    num,
    title,
    words,
    at,
    calls,
    tokens,
    review,
  }
}

function coerceCalls(o: Record<string, unknown>): CallBreakdown | null {
  const outline = Number(o['outline'])
  const draft = Number(o['draft'])
  const review = Number(o['review'])
  const total = Number(o['total'])
  const limit = Number(o['limit'])
  if (![outline, draft, review, total, limit].every((n) => Number.isFinite(n) && n >= 0)) return null
  return { outline, draft, review, total, limit }
}

function coerceReview(o: Record<string, unknown>): ReviewMetrics | null {
  const tier = o['tier']
  if (tier !== 'full' && tier !== 'sequential' && tier !== 'combined') return null
  const downgrade = o['downgrade'] === true
  const downgradeReason = typeof o['downgrade_reason'] === 'string' ? (o['downgrade_reason'] as string) : null
  const blockers = Number(o['blockers'])
  const warnings = Number(o['warnings'])
  const invalid = Number(o['invalid'])
  if (![blockers, warnings, invalid].every((n) => Number.isFinite(n) && n >= 0)) return null
  const lenses = Array.isArray(o['lenses']) ? (o['lenses'] as unknown[]).map(String) : []
  return { tier, downgrade, downgrade_reason: downgradeReason, blockers, warnings, invalid, lenses }
}

/** 默认上限解析（采集层 collect.ts 用）：override ?? config.budget.calls_per_chapter */
export function resolveCallLimit(config: BookConfig, limitOverride: number | undefined): number {
  return limitOverride ?? config.budget.calls_per_chapter
}
