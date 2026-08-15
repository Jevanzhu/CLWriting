/**
 * RAG 向量存取 —— 依据 M7 #37 spec 第 3/4/5 节。
 *
 * per-book .rag.db 生命周期 + 向量 BLOB 序列化 + 余弦召回。
 * 纯 node:sqlite + 纯 JS 余弦（零依赖，不引向量索引库）。
 */

import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'
import { createRagTables } from './schema.js'

/** 一个向量块（召回返回位置 + 向量，原文交精准读取从定稿取） */
export interface RagChunk {
  id: number
  章号: number
  start_offset: number
  end_offset: number
  /** Float32Array（从 BLOB 读回） */
  embedding: Float32Array
  model: string
  indexed_at: string
}

/** 建索引时写入的块（embedding 已算好） */
export interface ChunkInput {
  章号: number
  start_offset: number
  end_offset: number
  embedding: Float32Array
  model: string
}

/** Float32Array ↔ Buffer（BLOB 序列化） */
export function float32ToBuffer(arr: Float32Array): Buffer {
  return Buffer.from(new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength))
}

export function bufferToFloat32(blob: Uint8Array): Float32Array {
  if (blob.byteLength % 4 !== 0) return new Float32Array()
  const bytes = Uint8Array.from(blob)
  return new Float32Array(bytes.buffer)
}

/** 打开 per-book .rag.db（书仓库内，gitignore，独立 .cache） */
export function openRagDb(bookRoot: string): DatabaseSync {
  const dbPath = join(bookRoot, '.rag.db')
  const db = new DatabaseSync(dbPath)
  // P2-2：WAL 模式 + 忙等 5s，防并发写入 SQLITE_BUSY
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA busy_timeout = 5000')
  createRagTables(db)
  return db
}

/** 存一个块（embedding 序列化为 BLOB）。
 *  V-P2-3：INSERT OR REPLACE——(章号, 偏移, 模型) 有唯一键，同块重写幂等不重复。 */
export function storeChunk(db: DatabaseSync, chunk: ChunkInput): void {
  const stmt = db.prepare(
    `INSERT OR REPLACE INTO chunks (章号, start_offset, end_offset, embedding, model, indexed_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  )
  stmt.run(
    chunk.章号,
    chunk.start_offset,
    chunk.end_offset,
    float32ToBuffer(chunk.embedding),
    chunk.model,
    new Date().toISOString(),
  )
}

/**
 * 读全部块（召回用，全表线性扫描——#37 第 5 节）。
 * 规模量化（2026-08 实测，Apple Silicon，基准见 test/rag/scale.test.ts）：200 万字目标场景
 * 700 章 / 3.5 万块 / 1536 维（.rag.db ~277MB）单次召回 ~320-350ms，含全表 BLOB 读回 +
 * 逐块余弦 + 700 章指纹校验；线性外推：1 万块 ~100ms、几千块几十 ms（原「单本几千块 ms 级」
 * 成立）。结论：十万块内线性扫描可用，超出或要求 <100ms 交互时再议 FTS/向量索引（RC，
 * 需先量化收益）——在界值测试退化失败前明确不引索引。
 */
export function readAllChunks(db: DatabaseSync): RagChunk[] {
  const stmt = db.prepare('SELECT id, 章号, start_offset, end_offset, embedding, model, indexed_at FROM chunks')
  const rows = stmt.all() as Array<{
    id: number; 章号: number; start_offset: number; end_offset: number
    embedding: Uint8Array; model: string; indexed_at: string
  }>
  return rows.map((r) => ({
    id: r.id,
    章号: r.章号,
    start_offset: r.start_offset,
    end_offset: r.end_offset,
    embedding: bufferToFloat32(r.embedding),
    model: r.model,
    indexed_at: r.indexed_at,
  }))
}

/** rag_meta 读写（记维度/模型/已索引章号） */
export function getRagMeta(db: DatabaseSync, key: string): string | null {
  const stmt = db.prepare('SELECT value FROM rag_meta WHERE key = ?')
  const row = stmt.get(key) as { value: string } | undefined
  return row?.value ?? null
}

export function setRagMeta(db: DatabaseSync, key: string, value: string): void {
  const stmt = db.prepare('INSERT OR REPLACE INTO rag_meta (key, value) VALUES (?, ?)')
  stmt.run(key, value)
}

/**
 * 纯 JS 余弦相似度（#37 第 5 节，不引向量库）。
 * cos = dot(a,b) / (||a|| * ||b||)
 */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0
  const len = Math.min(a.length, b.length)
  let dot = 0
  let normA = 0
  let normB = 0
  for (let i = 0; i < len; i++) {
    dot += a[i]! * b[i]!
    normA += a[i]! * a[i]!
    normB += b[i]! * b[i]!
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB)
  return denom === 0 ? 0 : dot / denom
}
