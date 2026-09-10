/**
 * R1010b-CHK-P3-1（2026-09-10 内存专项重审修复批）回归：
 * RAG 损坏向量行（embedding BLOB 字节数非 4 倍数/空 BLOB → bufferToFloat32 返回空数组）
 * 此前在 readAllChunks/streamChunkScores 跳过两个毒形分支照常产出/计 produced，被下游按
 *「维度不匹配」记账——totalBlocks 虚增、poisonRows 恒 0 永不触发毒行 warn，作者得不到
 * 重建索引指引。修复后归毒行剔除（不占 produced 名额）。此形外部损坏才可达（storeChunk
 * 写入侧恒 Float32Array，序列化字节数恒 4 倍数）——测试以 UPDATE 直改 BLOB 构造。
 * 装置仿 test/rag/r34d-float32-overflow.test.ts（桩 embed 不联网，bookRoot 手建临时目录）。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { buildIndex, recallDetailed } from '../../src/rag/index.js'
import { openRagDb, readAllChunks, storeChunk, streamChunkScores } from '../../src/rag/store.js'
import { writeChapter } from '../helpers/chapter.js'
import type { ChapterMeta } from '../../src/format/types.js'
import type { EmbedResult } from '../../src/rag/embed.js'

/** 好桩：确定性 3 维（与 r34d 同款） */
function cleanEmbed(_e: string, _m: string, _k: string, texts: string[]): Promise<EmbedResult> {
  return Promise.resolve(
    texts.map((t) => {
      const norm = 1 / ((t.charCodeAt(0) || 1) + 1)
      return [norm, norm * 0.5, norm * 0.3]
    }),
  )
}

const RAG_CONFIG = { enabled: true, endpoint: 'http://stub', model: 'stub-model' }

describe('R1010b-CHK-P3-1：坏长度 embedding BLOB 归毒行（store 层直测）', () => {
  let bookRoot: string
  beforeEach(() => {
    bookRoot = join(tmpdir(), `rag-r1010b-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    mkdirSync(join(bookRoot, '.cache'), { recursive: true })
  })
  afterEach(() => rmSync(bookRoot, { recursive: true, force: true }))

  /** 两章各 1 块（章 1/章 2），随后把章 1 行 embedding 直改为坏长度 BLOB */
  function seedTwoChunks(corruptBlobSql: string): void {
    const db = openRagDb(bookRoot)
    try {
      storeChunk(db, { 章号: 1, start_offset: 0, end_offset: 10, embedding: Float32Array.from([0.1, 0.2, 0.3]), model: 'm' })
      storeChunk(db, { 章号: 2, start_offset: 0, end_offset: 10, embedding: Float32Array.from([0.2, 0.4, 0.6]), model: 'm' })
      db.exec(`UPDATE chunks SET embedding = ${corruptBlobSql} WHERE 章号 = 1`) // norm 保持原非 null 值——正是「norm 非 null 但向量序列化损坏」形态
    } finally {
      db.close()
    }
  }

  it('非 4 倍数 BLOB → streamChunkScores poisonRows 计入、不占 produced 名额、不进 rows；好行照常（fail-closed 不误伤）', () => {
    seedTwoChunks("X'010203'") // 3 字节：byteLength % 4 !== 0 → bufferToFloat32 返回空数组
    const db = openRagDb(bookRoot)
    try {
      const r = streamChunkScores(db, new Float32Array([0.1, 0.2, 0.3]), 'm', 100)
      expect(r.poisonRows).toBe(1)
      expect(r.produced).toBe(1) // 修复前：2（坏行占 produced 名额，被「维度不匹配」记账）
      expect(r.rows.map((row) => row.章号)).toEqual([2]) // 坏行不进命中，好行保留
      // 早停口径（R37-38/R49-20 同款）：毒行剔除不计产出额，maxRows=1 仍能读到好行
      const r1 = streamChunkScores(db, new Float32Array([0.1, 0.2, 0.3]), 'm', 1)
      expect(r1.produced).toBe(1)
      expect(r1.rows.map((row) => row.章号)).toEqual([2])
    } finally {
      db.close()
    }
  })

  it('空 BLOB → 同毒行口径（bufferToFloat32 空 Float32Array 两态同判）', () => {
    seedTwoChunks("X''")
    const db = openRagDb(bookRoot)
    try {
      const r = streamChunkScores(db, new Float32Array([0.1, 0.2, 0.3]), 'm', 100)
      expect(r.poisonRows).toBe(1)
      expect(r.produced).toBe(1)
      expect(r.rows.map((row) => row.章号)).toEqual([2])
    } finally {
      db.close()
    }
  })

  it('readAllChunks：坏行不产出 + 既有毒行告警口径触发（建议重建索引）', async () => {
    seedTwoChunks("X'010203'")
    const logMod = await import('../../src/log/index.js')
    const spy = vi.spyOn(logMod.log, 'warn').mockImplementation(() => {})
    try {
      const db = openRagDb(bookRoot)
      let out
      try {
        out = readAllChunks(db)
      } finally {
        db.close()
      }
      expect(out.map((c) => c.章号)).toEqual([2]) // 坏行剔除，好行照常
      expect(spy.mock.calls.some((c) => c[1]!.includes('毒向量块'))).toBe(true)
    } finally {
      spy.mockRestore()
    }
  })
})

describe('R1010b-CHK-P3-1：recall 全链（buildIndex 装置 + UPDATE 坏行）', () => {
  let bookRoot: string
  beforeEach(() => {
    bookRoot = join(tmpdir(), `rag-r1010bfull-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    mkdirSync(join(bookRoot, '写作', '正文'), { recursive: true })
    for (const n of [1, 2]) {
      const meta: ChapterMeta = {
        章号: n, 标题: `第${n}章`, 钩子类型: '悬念钩', 钩子强弱: '中', 情绪定位: '铺垫',
        _path: '', _wordCount: 100,
      }
      writeChapter(join(bookRoot, '写作', '正文', `${n}-第${n}章.md`), meta, `第${n}章正文，战斗场景描写充分，主角挥剑。`)
    }
  })
  afterEach(() => rmSync(bookRoot, { recursive: true, force: true }))

  it('坏行章不进命中 + 毒行 warn 触发 + totalBlocks 不再虚增；好章照常召回', async () => {
    const built = await buildIndex(bookRoot, RAG_CONFIG, 'key', cleanEmbed)
    expect(built.ok).toBe(true)
    // 直改章 1 行 embedding 为非 4 倍数 BLOB（norm 保持非 null——写入侧不可达的外部损坏形态）
    const db = openRagDb(bookRoot)
    try {
      db.exec("UPDATE chunks SET embedding = X'010203' WHERE 章号 = 1")
    } finally {
      db.close()
    }
    const logMod = await import('../../src/log/index.js')
    const spy = vi.spyOn(logMod.log, 'warn').mockImplementation(() => {})
    try {
      const result = await recallDetailed(bookRoot, RAG_CONFIG, 'key', '战斗', 5, cleanEmbed)
      expect(result.hits.every((h) => h.章号 !== 1)).toBe(true) // 损坏行绝不进命中（fail-closed 不变）
      expect(result.hits.some((h) => h.章号 === 2)).toBe(true) // 好章不误伤
      expect(result.totalBlocks).toBe(1) // 修复前：2（坏行按「维度不匹配」占 produced）
      expect(spy.mock.calls.some((c) => c[1]!.includes('毒向量块'))).toBe(true) // 作者得到重建索引指引
    } finally {
      spy.mockRestore()
    }
  })
})
