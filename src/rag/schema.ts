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
  // V-P2-3：分块唯一键（章号+偏移区间+模型）——中断重跑不得重复 INSERT
  // （重复 embed 费用翻倍、召回重复命中）。存量库可能有历史重复行（直接建唯一索引
  // 会 SQLITE_CONSTRAINT 失败），失败分支先按 MIN(id) 去重再建。
  try {
    db.exec(
      'CREATE UNIQUE INDEX IF NOT EXISTS idx_chunks_unique ON chunks(章号, start_offset, end_offset, model)',
    )
  } catch {
    db.exec(
      'DELETE FROM chunks WHERE id NOT IN (SELECT MIN(id) FROM chunks GROUP BY 章号, start_offset, end_offset, model)',
    )
    db.exec(
      'CREATE UNIQUE INDEX IF NOT EXISTS idx_chunks_unique ON chunks(章号, start_offset, end_offset, model)',
    )
  }
}

export { RAG_DDL }
