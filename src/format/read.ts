/**
 * 精准读取 —— 依据 #4 第 4 节查询样例。
 *
 * 从 .cache/index.db 按需读取片段（母本第 0.3 节原则 5「精准读取」）。
 * 不读正文全文（正文 grep 查），只读结构化字段 + 定位。
 */

import type { DatabaseSync } from 'node:sqlite'
import type { LeadEntry, LeadType } from './types.js'

// ── 账本查询（#4 第 4 节）────────────────────────

/** 读某条线的履历（按行序） */
export function readLeadHistory(db: DatabaseSync, leadId: string): LeadEntry[] {
  const rows = db.prepare(
    'SELECT chapter, verb, evidence, backfill FROM lead_history WHERE lead_id = ? ORDER BY seq',
  ).all(leadId) as Record<string, unknown>[]
  return rows.map((r) => ({
    章号: r['chapter'] as number,
    动词: r['verb'] as string,
    证据: r['evidence'] as string,
    ...(r['backfill'] ? { 回填: true } : {}),
  }))
}

/** "悬太久"候选（进行中的线，按开启章排序） */
export function readStaleLeads(
  db: DatabaseSync,
  currentChapter: number,
  thresholds: Record<string, number>,
  defaultThreshold = 30,
): { id: string; type: LeadType; openedAt: number; age: number; overThreshold: boolean }[] {
  const rows = db.prepare(
    `SELECT id, type, opened_at FROM leads WHERE status = '进行中' ORDER BY opened_at`,
  ).all() as Record<string, unknown>[]
  return rows.map((r) => {
    const type = r['type'] as LeadType
    const openedAt = r['opened_at'] as number
    const threshold = thresholds[type] ?? defaultThreshold
    const age = currentChapter - openedAt
    return {
      id: r['id'] as string,
      type,
      openedAt,
      age,
      overThreshold: age >= threshold,
    }
  })
}

// ── 摘要查询（#4 第 4 节）────────────────────────

/** 读某章号范围的章摘要 path */
export function readChapterSummaries(
  db: DatabaseSync,
  from: number,
  to: number,
): { ref: number; path: string }[] {
  const rows = db.prepare(
    `SELECT ref, path FROM summaries WHERE scope = 'chapter' AND ref BETWEEN ? AND ? ORDER BY ref`,
  ).all(from, to) as Record<string, unknown>[]
  return rows.map((r) => ({
    ref: r['ref'] as number,
    path: r['path'] as string,
  }))
}

// ── 成长线语义机检取数（#4 第 4 节）──────────────

/** 读成长线履历（单调/跨度机检的数据源，校验逻辑属 M2）。
 *  R35-3（三十五轮）：补选 backfill 列并映射（对齐 readLeadHistory 的 `回填` 字段
 *  口径）——两读取器此前口径分裂，成长线机检拿不到回填标记，后补录的早期低阶跃迁
 *  按 seq 序被判成境界回退假红。 */
export function readGrowthHistory(
  db: DatabaseSync,
  leadId: string,
): { chapter: number; verb: string; evidence: string; backfill?: boolean }[] {
  const rows = db.prepare(
    'SELECT chapter, verb, evidence, backfill FROM lead_history WHERE lead_id = ? ORDER BY seq',
  ).all(leadId) as Record<string, unknown>[]
  return rows.map((r) => ({
    chapter: r['chapter'] as number,
    verb: r['verb'] as string,
    evidence: r['evidence'] as string,
    ...(r['backfill'] ? { backfill: true } : {}),
  }))
}

/** 读成长线当前境界 */
export function readCurrentRealm(db: DatabaseSync, leadId: string): string | null {
  const row = db.prepare('SELECT cur_realm FROM leads WHERE id = ?').get(leadId) as
    | { cur_realm: string | null }
    | undefined
  return row?.cur_realm ?? null
}
