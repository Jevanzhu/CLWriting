/**
 * RAG 向量库 schema（per-book .rag.db）—— 依据 M7 #37 spec 第 3 节。
 *
 * 落书仓库内、gitignore、独立于 .cache（删 .cache 不连带删向量，免重 embed）。
 * 零依赖：node:sqlite 存 BLOB，纯 JS 读回算余弦。
 */

import type { DatabaseSync } from 'node:sqlite'

/** chunks 表 + rag_meta 表 DDL */
const RAG_DDL = [
  `CREATE TABLE IF NOT EXISTS chunks (
    id           INTEGER PRIMARY KEY,
    章号         INTEGER NOT NULL,
    start_offset INTEGER NOT NULL,
    end_offset   INTEGER NOT NULL,
    embedding    BLOB NOT NULL,
    model        TEXT NOT NULL,
    indexed_at   TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_chunks_chapter ON chunks(章号)`,
  `CREATE TABLE IF NOT EXISTS rag_meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )`,
] as const

/** 建 RAG 表（幂等 IF NOT EXISTS） */
export function createRagTables(db: DatabaseSync): void {
  for (const stmt of RAG_DDL) db.exec(stmt)
}

export { RAG_DDL }
