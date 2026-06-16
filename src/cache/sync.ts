/**
 * 内存模型 → 缓存入库 —— 中英 key 映射收口处（④ 第 6 节）。
 *
 * 所有 md（中文 key）↔ 内存模型 ↔ 缓存（英文列）的映射集中在此，
 * 便于「运行时零依赖」下集中维护。
 */

import type { DatabaseSync } from 'node:sqlite'
import type { Lead, LeadEntry, ChapterMeta } from '../format/types.js'

// ── 账本入库（④ 第 6 节映射表）──────────────────

/** 写入一个 Lead 到 leads 表 + lead_history 表 */
export function syncLead(db: DatabaseSync, lead: Lead): void {
  db.prepare(
    `INSERT OR REPLACE INTO leads
      (id, type, title, status, opened_at, cur_realm, parent_id, debtor, creditor, path)
     VALUES (@id, @type, @title, @status, @opened_at, @cur_realm, @parent_id, @debtor, @creditor, @path)`,
  ).all({
    // 中英映射（④ 第 6 节）
    id: lead.编号,
    type: lead.类型,
    title: lead.标题,
    status: lead.状态,
    opened_at: lead.开启章,
    cur_realm: lead.当前境界 ?? null,
    parent_id: lead.父局线 ?? null,
    debtor: lead.欠方 ?? null,
    creditor: lead.债主 ?? null,
    path: lead._path ?? '',
  })

  // 履历：先删旧的再插（幂等）
  db.prepare('DELETE FROM lead_history WHERE lead_id = ?').all(lead.编号)
  const insertHistory = db.prepare(
    `INSERT INTO lead_history (lead_id, seq, chapter, verb, evidence, backfill)
     VALUES (@lead_id, @seq, @chapter, @verb, @evidence, @backfill)`,
  )
  lead.履历.forEach((entry: LeadEntry, i: number) => {
    insertHistory.all({
      lead_id: lead.编号,
      seq: i + 1,
      chapter: entry.章号,
      verb: entry.动词,
      evidence: entry.证据,
      backfill: entry.回填 ? 1 : 0,
    })
  })
}

/** 从缓存读回一个 Lead（按 id）—— 用于验证入库一致性 */
export function loadLeadFromCache(
  db: DatabaseSync,
  id: string,
): Lead | null {
  const row = db.prepare('SELECT * FROM leads WHERE id = ?').get(id) as
    | Record<string, unknown>
    | undefined
  if (!row) return null

  const historyRows = db.prepare(
    'SELECT chapter, verb, evidence, backfill FROM lead_history WHERE lead_id = ? ORDER BY seq',
  ).all(id) as Record<string, unknown>[]

  const lead: Lead = {
    编号: row['id'] as string,
    标题: row['title'] as string,
    类型: row['type'] as Lead['类型'],
    状态: row['status'] as Lead['状态'],
    开启章: row['opened_at'] as number,
    履历: historyRows.map((h) => ({
      章号: h['chapter'] as number,
      动词: h['verb'] as string,
      证据: h['evidence'] as string,
      ...(h['backfill'] ? { 回填: true } : {}),
    })),
    _path: row['path'] as string,
  }
  if (row['cur_realm']) lead.当前境界 = row['cur_realm'] as string
  if (row['parent_id']) lead.父局线 = row['parent_id'] as string
  if (row['debtor']) lead.欠方 = row['debtor'] as string
  if (row['creditor']) lead.债主 = row['creditor'] as string

  return lead
}

// ── 章节入库（⑦ 第 5 节对接 chapters 表）────────

export function syncChapter(db: DatabaseSync, ch: ChapterMeta): void {
  db.prepare(
    `INSERT OR REPLACE INTO chapters
      (number, title, word_count, hook_type, hook_level, emotion, path)
     VALUES (@number, @title, @word_count, @hook_type, @hook_level, @emotion, @path)`,
  ).all({
    number: ch.章号,
    title: ch.标题,
    word_count: ch._wordCount ?? 0,
    hook_type: ch.钩子类型 ?? null,
    hook_level: ch.钩子强弱 ?? null,
    emotion: ch.情绪定位 ?? null,
    path: ch._path ?? '',
  })
}

// ── 摘要入库（④ 第 3 节 summaries 表）────────────

export function syncSummary(
  db: DatabaseSync,
  scope: 'chapter' | 'volume',
  ref: number,
  path: string,
): void {
  db.prepare(
    `INSERT OR REPLACE INTO summaries (scope, ref, path) VALUES (?, ?, ?)`,
  ).all(scope, ref, path)
}

// ── meta（重建戳等）─────────────────────────────

export function setMeta(db: DatabaseSync, key: string, value: string): void {
  db.prepare(
    `INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)`,
  ).all(key, value)
}

export function getMeta(db: DatabaseSync, key: string): string | null {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as
    | { value: string }
    | undefined
  return row?.value ?? null
}
