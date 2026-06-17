/**
 * 精准读取 —— 依据 #4 第 4 节查询样例。
 *
 * 从 .cache/index.db 按需读取片段（母本第 0.3 节原则 5「精准读取」）。
 * 不读正文全文（正文 grep 查），只读结构化字段 + 定位。
 */

import type { DatabaseSync } from 'node:sqlite'
import type { LeadEntry, LeadStatus, LeadType } from '../format/types.js'

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

/** 读某条线当前状态 */
export function readLeadStatus(
  db: DatabaseSync,
  leadId: string,
): { status: LeadStatus; type: LeadType; title: string; openedAt: number } | null {
  const row = db.prepare(
    'SELECT status, type, title, opened_at FROM leads WHERE id = ?',
  ).get(leadId) as Record<string, unknown> | undefined
  if (!row) return null
  return {
    status: row['status'] as LeadStatus,
    type: row['type'] as LeadType,
    title: row['title'] as string,
    openedAt: row['opened_at'] as number,
  }
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

// ── 章节查询 ────────────────────────────────────

/** 读某章定位（path + 字数） */
export function readChapterLocation(
  db: DatabaseSync,
  chapterNum: number,
): { path: string; wordCount: number; title: string } | null {
  const row = db.prepare(
    'SELECT path, word_count, title FROM chapters WHERE number = ?',
  ).get(chapterNum) as Record<string, unknown> | undefined
  if (!row) return null
  return {
    path: row['path'] as string,
    wordCount: row['word_count'] as number,
    title: row['title'] as string,
  }
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

/** 读卷摘要 path */
export function readVolumeSummaries(
  db: DatabaseSync,
  from?: number,
  to?: number,
): { ref: number; path: string }[] {
  if (from !== undefined && to !== undefined) {
    const rows = db.prepare(
      `SELECT ref, path FROM summaries WHERE scope = 'volume' AND ref BETWEEN ? AND ? ORDER BY ref`,
    ).all(from, to) as Record<string, unknown>[]
    return rows.map((r) => ({ ref: r['ref'] as number, path: r['path'] as string }))
  }
  const rows = db.prepare(
    `SELECT ref, path FROM summaries WHERE scope = 'volume' ORDER BY ref`,
  ).all() as Record<string, unknown>[]
  return rows.map((r) => ({ ref: r['ref'] as number, path: r['path'] as string }))
}

// ── 成长线语义机检取数（#4 第 4 节）──────────────

/** 读成长线履历（单调/跨度机检的数据源，校验逻辑属 M2） */
export function readGrowthHistory(
  db: DatabaseSync,
  leadId: string,
): { chapter: number; verb: string; evidence: string }[] {
  const rows = db.prepare(
    'SELECT chapter, verb, evidence FROM lead_history WHERE lead_id = ? ORDER BY seq',
  ).all(leadId) as Record<string, unknown>[]
  return rows.map((r) => ({
    chapter: r['chapter'] as number,
    verb: r['verb'] as string,
    evidence: r['evidence'] as string,
  }))
}

/** 读成长线当前境界 */
export function readCurrentRealm(db: DatabaseSync, leadId: string): string | null {
  const row = db.prepare('SELECT cur_realm FROM leads WHERE id = ?').get(leadId) as
    | { cur_realm: string | null }
    | undefined
  return row?.cur_realm ?? null
}
