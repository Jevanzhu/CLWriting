/**
 * R35-44（三十五轮）回归：ensureNormColumn 双进程竞态窗口幂等。
 *
 * 仅存量旧库首次升级可发：PRAGMA table_info 探测无 norm 列 → 他进程先 ALTER 加列 →
 * 本进程 ALTER 撞「duplicate column name」——此前原样上抛把并发开库炸成硬错。修复：
 * duplicate column 视为升级完成（窄匹配），其他错误原样上抛。
 * 竞态终态用 Proxy 包装句柄模拟：prepare 对 PRAGMA table_info 谎报无列（探测与 ALTER
 * 之间他进程加列完成，等价于探测拿到旧 schema），ALTER 走真实句柄 → 必撞 duplicate
 * column，确定性复现该分支（双进程真并发定时依赖重、不稳定，不采用）。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { openRagDb, ensureNormColumn, storeChunk, readAllChunks } from '../../src/rag/store.js'

/** PRAGMA table_info 谎报无列的包装句柄（其余调用全部透传真实句柄，bind 防 receiver 品牌检查） */
function lyingTableInfo(db: DatabaseSync): DatabaseSync {
  return new Proxy(db, {
    get(target, prop) {
      if (prop === 'prepare') {
        return (sql: string) => (sql.includes('table_info') ? { all: () => [] } : target.prepare(sql))
      }
      const v = Reflect.get(target, prop)
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v
    },
  }) as unknown as DatabaseSync
}

describe('R35-44：ensureNormColumn duplicate column 竞态幂等', () => {
  let bookRoot: string

  beforeEach(() => {
    bookRoot = join(tmpdir(), `rag-r35-normrace-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    mkdirSync(bookRoot, { recursive: true })
  })

  afterEach(() => rmSync(bookRoot, { recursive: true, force: true }))

  it('探测谎报无列、ALTER 撞 duplicate column（他进程已加列）→ 不上抛、数据无损', () => {
    const db = openRagDb(bookRoot) // norm 列已由本次首升建好
    try {
      storeChunk(db, { 章号: 1, start_offset: 0, end_offset: 10, embedding: Float32Array.from([0.1, 0.2, 0.3]), model: 'm' })
      expect(() => ensureNormColumn(lyingTableInfo(db))).not.toThrow()
      expect(readAllChunks(db)).toHaveLength(1)
    } finally {
      db.close()
    }
  })

  it('竞态吞错后回填仍生效：norm=NULL 的存量行照常补算范数', () => {
    const db = openRagDb(bookRoot)
    try {
      // 模拟旧版行（norm 列后加、值为 NULL；embedding 4 字节 = [0] 单分量）
      db.exec(
        "INSERT INTO chunks (章号, start_offset, end_offset, embedding, model, indexed_at) VALUES (2, 0, 4, x'00000000', 'm', '2026-01-01T00:00:00.000Z')",
      )
      ensureNormColumn(lyingTableInfo(db))
      const row = db.prepare('SELECT norm FROM chunks WHERE 章号 = 2').get() as { norm: number | null }
      expect(row.norm).not.toBeNull()
      expect(Number.isFinite(row.norm)).toBe(true)
    } finally {
      db.close()
    }
  })

  it('重复调用 ensureNormColumn 幂等：列不重复、norm 列恰一个', () => {
    const db = openRagDb(bookRoot)
    try {
      ensureNormColumn(db)
      ensureNormColumn(db)
      const cols = db.prepare('PRAGMA table_info(chunks)').all() as Array<{ name: string }>
      expect(cols.filter((c) => c.name === 'norm')).toHaveLength(1)
    } finally {
      db.close()
    }
  })
})
