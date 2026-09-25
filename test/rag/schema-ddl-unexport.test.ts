/**
 * R37-37（三十七轮）：RAG_DDL 死导出回收回归。
 * 修复前 schema.ts 导出 RAG_DDL（全库生产+测试零 import）——导出面平白扩大内部
 * schema 契约。修复后 RAG_DDL 回收为内部常量；schema 契约断言改走真实建库路径
 * （createRagTables 建表后查 sqlite_master/PRAGMA）。
 */
import { describe, it, expect } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import * as schema from '../../src/rag/schema.js'
import { createRagTables } from '../../src/rag/schema.js'

describe('R37-37: RAG_DDL 不再导出（死导出回收）', () => {
  it('schema 模块导出面收口：RAG_DDL 回收为内部常量，createRagTables 照常可用', () => {
    // R37-37：修复前 `export { RAG_DDL }` 在册；回收后模块命名空间不得再出现该键
    expect(Object.keys(schema)).not.toContain('RAG_DDL')
    expect(typeof schema.createRagTables).toBe('function')
  })

  it('真实建库路径断言 schema：chunks/rag_meta 表 + 唯一索引 + 关键列在位（幂等）', () => {
    const db = new DatabaseSync(':memory:')
    try {
      createRagTables(db)
      // 二次建库幂等（IF NOT EXISTS）——回收导出不改运行时契约
      createRagTables(db)

      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('chunks', 'rag_meta') ORDER BY name")
        .all() as Array<{ name: string }>
      expect(tables.map((t) => t.name)).toEqual(['chunks', 'rag_meta'])

      // V-P2-3 唯一索引（中断重跑不重复 INSERT 的契约面）
      const idx = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_chunks_unique'")
        .get() as { name: string } | undefined
      expect(idx?.name).toBe('idx_chunks_unique')

      // chunks 关键列（含 A3 的 norm 列——RAG_DDL 直接建列，无历史 ALTER 形态）
      const cols = (db.prepare('PRAGMA table_info(chunks)').all() as Array<{ name: string }>).map((c) => c.name)
      for (const col of ['id', '章号', 'start_offset', 'end_offset', 'embedding', 'model', 'indexed_at', 'norm']) {
        expect(cols).toContain(col)
      }
    } finally {
      db.close()
    }
  })
})
