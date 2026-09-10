/**
 * R0910-W（2026-09-10 修复批）回归：ensureNormColumn 的 `norm IS NULL` 探测走部分索引。
 *
 * 原实现该探测无索引——每次 openRagDb 全表扫（约 3.5 万块/书），回填完成后仍全扫；
 * recallDetailed 一次召回开库两次。修复：openRagDb 在 ensureNormColumn 之后建部分索引
 * `idx_chunks_norm_null ON chunks(id) WHERE norm IS NULL`，探测降为索引扫描。本用例
 * 断言索引存在且查询计划命中它（防回退全表扫）。
 */
import { test, expect } from 'vitest'
import { mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdtempTracked } from '../helpers/temp-dir.js'
import { openRagDb, storeChunk } from '../../src/rag/store.js'

test('R0910-W：norm IS NULL 探测命中部分索引（不回退全表扫）', () => {
  const root = mkdtempTracked(join(tmpdir(), 'rag-norm-idx-'))
  mkdirSync(root, { recursive: true })
  const db = openRagDb(root)
  try {
    // 索引已随 open 建好
    const idx = db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_chunks_norm_null'")
      .get() as { name: string } | undefined
    expect(idx?.name).toBe('idx_chunks_norm_null')

    // 写入带 norm 的正常行（storeChunk 即时算范数 → 无 NULL 行）
    storeChunk(db, { 章号: 1, start_offset: 0, end_offset: 10, embedding: Float32Array.from([0.1, 0.2, 0.3]), model: 'm' })

    // 查询计划必须用索引（SEARCH ... USING ... INDEX idx_chunks_norm_null）
    const plan = db
      .prepare('EXPLAIN QUERY PLAN SELECT id, embedding FROM chunks WHERE norm IS NULL')
      .all() as Array<{ detail: string }>
    const text = plan.map((r) => r.detail).join(' ')
    expect(text).toContain('idx_chunks_norm_null')
  } finally {
    db.close()
    rmSync(root, { recursive: true, force: true })
  }
})
