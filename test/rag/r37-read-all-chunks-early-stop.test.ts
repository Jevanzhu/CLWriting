/**
 * R37-38（三十七轮）：readAllChunks maxChunks 早停回归。
 * 修复前召回侧只为截断告警却把全表 chunk 读进内存再 slice（大库数万行白读）。
 * 修复：可选 maxChunks 读到即停，语义恒等于全量读后 slice(0, maxChunks)
 * （iterate 行序 = rowid 序 = 插入序；毒行剔除不计早停额——slice 作用在剔毒后）。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { DatabaseSync } from 'node:sqlite'
import { openRagDb, storeChunk, readAllChunks, float32ToBuffer } from '../../src/rag/store.js'

describe('R37-38: readAllChunks maxChunks 早停', () => {
  let bookRoot: string
  let db: DatabaseSync

  beforeEach(() => {
    bookRoot = join(tmpdir(), `rag-r37-38-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    mkdirSync(bookRoot, { recursive: true })
    db = openRagDb(bookRoot)
    // 10 行干净块（插入序 = rowid 序，章号/偏移互异不撞唯一键）
    for (let i = 0; i < 10; i++) {
      storeChunk(db, {
        章号: i + 1,
        start_offset: i * 100,
        end_offset: i * 100 + 50,
        embedding: Float32Array.from([1, i + 1, 0.5]),
        model: 'stub-model',
      })
    }
  })

  afterEach(() => {
    db.close()
    rmSync(bookRoot, { recursive: true, force: true })
  })

  it('建库插 10 行：readAllChunks(db, 5) 返回 5 行且与全读 slice(0,5) 逐项相同', () => {
    const full = readAllChunks(db)
    expect(full).toHaveLength(10)
    const head = readAllChunks(db, 5)
    expect(head).toHaveLength(5)
    // 早停序 = 全读前缀序（无 ORDER BY 下 iterate 行序 = rowid 序 = 插入序）
    expect(head.map((c) => c.id)).toEqual(full.slice(0, 5).map((c) => c.id))
    expect(head).toEqual(full.slice(0, 5)) // 含 embedding（Float32Array 按值比较）
  })

  it('maxChunks 超过总数（20）：全量返回，与缺省全读恒等', () => {
    expect(readAllChunks(db, 20).map((c) => c.id)).toEqual(readAllChunks(db).map((c) => c.id))
  })

  it('边界：maxChunks=0 → 空；undefined → 全量 10（缺省口径不变）', () => {
    expect(readAllChunks(db, 0)).toEqual([])
    expect(readAllChunks(db)).toHaveLength(10)
  })

  it('毒行剔除不计早停额：限额只数产出行（与全量读后 slice 语义恒等）', () => {
    // 造一行毒行且排迭代序最前（显式 id=0 < 干净块 rowid 1..10）：R35-40 实际可达
    // 形态——norm=NULL 且 embedding 含非有限分量（Float32 溢出物化 ±Infinity）
    db.prepare(
      `INSERT INTO chunks (id, 章号, start_offset, end_offset, embedding, model, indexed_at, norm)
       VALUES (0, 1, 1000, 1050, ?, 'poison-model', ?, NULL)`,
    ).run(float32ToBuffer(Float32Array.from([Infinity, 1, 0])), new Date().toISOString())

    const full = readAllChunks(db) // 全读剔毒：仍 10 行（毒行 id=0 不产出）
    expect(full).toHaveLength(10)
    // 早停 5 条：毒行在最前但不占额——产出恰为干净块前 5（id 1..5）
    const head = readAllChunks(db, 5)
    expect(head).toHaveLength(5)
    expect(head).toEqual(full.slice(0, 5))
    expect(head.every((c) => c.id >= 1 && c.id <= 5)).toBe(true)
  })
})
