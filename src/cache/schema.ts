/**
 * 缓存表 DDL —— 依据 #4 缓存表 DDL spec 第 3 节。
 *
 * 设计原则（#4 第 1 节）：
 * 1. 派生不是真相——所有数据从 md 重建，删 .cache 可恢复
 * 2. 机器域用英文——表名/列名英文，与账本 md 的中文 key 通过 sync 映射
 * 3. 存索引与定位不存正文——正文 grep 查，DB 只存结构化字段 + path 回指
 * 4. 纯 node:sqlite——标准 SQL，逻辑外键由重建保证
 *
 * 5 张表：leads / lead_history / chapters / summaries / meta
 */

import type { DatabaseSync } from 'node:sqlite'

/** 全部建表 DDL（#4 第 3 节） */
const DDL_STATEMENTS = [
  // ── 账本主表：七类统一，type 区分 ──
  `CREATE TABLE IF NOT EXISTS leads (
    id         TEXT PRIMARY KEY,
    type       TEXT NOT NULL,
    title      TEXT NOT NULL,
    status     TEXT NOT NULL,
    opened_at  INTEGER NOT NULL,
    cur_realm  TEXT,
    parent_id  TEXT,
    debtor     TEXT,
    creditor   TEXT,
    path       TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_leads_type   ON leads(type)`,
  `CREATE INDEX IF NOT EXISTS idx_leads_status ON leads(status)`,

  // ── 履历：每条履历行一条记录 ──
  `CREATE TABLE IF NOT EXISTS lead_history (
    lead_id   TEXT NOT NULL,
    seq       INTEGER NOT NULL,
    chapter   INTEGER NOT NULL,
    verb      TEXT NOT NULL,
    evidence  TEXT NOT NULL,
    backfill  INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (lead_id, seq)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_history_chapter ON lead_history(chapter)`,
  `CREATE INDEX IF NOT EXISTS idx_history_lead    ON lead_history(lead_id)`,

  // ── 章节元数据 ──
  `CREATE TABLE IF NOT EXISTS chapters (
    number      INTEGER PRIMARY KEY,
    title       TEXT NOT NULL,
    word_count  INTEGER NOT NULL,
    hook_type   TEXT,
    hook_level  TEXT,
    emotion     TEXT,
    path        TEXT NOT NULL
  )`,

  // ── 摘要索引 ──
  `CREATE TABLE IF NOT EXISTS summaries (
    scope  TEXT NOT NULL,
    ref    INTEGER NOT NULL,
    path   TEXT NOT NULL,
    PRIMARY KEY (scope, ref)
  )`,

  // ── 重建元信息 / 健康自检 ──
  `CREATE TABLE IF NOT EXISTS meta (
    key    TEXT PRIMARY KEY,
    value  TEXT NOT NULL
  )`,

  // ── A1（批 1）：树红点增量缓存——按章 stat 指纹命中的机检结果缓存。
  // 注意：本表与 tree_issues_meta 不在 clearAllTables 清单里——rebuild 全量重建
  // 清空的是「源文件派生索引」，机检缓存按章指纹自行失效，rebuild 不构成失效源
  // （改 1 章 → 只重查那 1 章，不能连坐全书）。
  `CREATE TABLE IF NOT EXISTS tree_issues_cache (
    rel_path    TEXT PRIMARY KEY,   -- 相对书根的章路径
    mtime_ms    INTEGER NOT NULL,   -- 正文文件指纹
    size        INTEGER NOT NULL,
    verdict_fp  TEXT,               -- 项目/分析/<docId>.json 的 "mtime:size"；NULL=无信封
    report_json TEXT NOT NULL       -- {hasRed, verdictRejected}（聚合输出同构）
  )`,
  `CREATE TABLE IF NOT EXISTS tree_issues_meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )`,
] as const

/** A1：树红点缓存表独立 ensure——增量 rebuild 跳过路径不跑 createAllTables，
 *  旧库（本表缺席）按需补建（幂等，IF NOT EXISTS）。 */
export function ensureTreeIssuesTables(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS tree_issues_cache (
    rel_path    TEXT PRIMARY KEY,
    mtime_ms    INTEGER NOT NULL,
    size        INTEGER NOT NULL,
    verdict_fp  TEXT,
    report_json TEXT NOT NULL
  )`)
  db.exec(`CREATE TABLE IF NOT EXISTS tree_issues_meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )`)
}

/** 在给定 db 上建全部表（幂等，IF NOT EXISTS） */
export function createAllTables(db: DatabaseSync): void {
  for (const stmt of DDL_STATEMENTS) {
    db.exec(stmt)
  }
}

/** 清空全部表数据（重建前调用，保留表结构） */
export function clearAllTables(db: DatabaseSync): void {
  const tables = ['lead_history', 'leads', 'chapters', 'summaries', 'meta']
  for (const t of tables) {
    db.exec(`DELETE FROM ${t}`)
  }
}

export { DDL_STATEMENTS }
