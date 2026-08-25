/**
 * RAG 向量存取 —— 依据 M7 #37 spec 第 3/4/5 节。
 *
 * per-book RAG 库（.cache/rag.db）生命周期 + 向量 BLOB 序列化 + 余弦召回。
 * 纯 node:sqlite + 纯 JS 余弦（零依赖，不引向量索引库）。
 */

import { DatabaseSync } from 'node:sqlite'
import { existsSync, mkdirSync, renameSync } from 'node:fs'
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
  /** A3（批 7）：预存 L2 范数（存量行由 ensureNormColumn 回填；异常缺失时召回侧现算兜底） */
  norm: number | null
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

/** RAG 库落点（书仓库 .cache/ 派生缓存区，与 index.db 同惯例——hh §八-11 迁入） */
function newRagDbPath(bookRoot: string): string {
  return join(bookRoot, '.cache', 'rag.db')
}

/** 旧版落点（书根裸 .rag.db）——只作迁移探测，不再往这里新建 */
function legacyRagDbPath(bookRoot: string): string {
  return join(bookRoot, '.rag.db')
}

/** RAG 库是否已建（新路径或未迁移的旧路径任一在即算——status 轮询不误报「未建索引」） */
export function ragDbExists(bookRoot: string): boolean {
  return existsSync(newRagDbPath(bookRoot)) || existsSync(legacyRagDbPath(bookRoot))
}

/**
 * 解析 RAG 库实际落点（hh §八-11：.rag.db → .cache/rag.db，openRagDb/存在性探测同源）。
 *
 * 兼容迁移：旧路径存在且新路径不存在 → 建好 .cache 后 renameSync 旧→新（同目录树
 * 原子，不拷贝不重写）。新路径已存在则不迁（以新为准，旧文件视为残留不动）。
 * 迁移失败（.cache 建不成 / rename 抛错，如跨卷 EXDEV、权限）降级：返回旧路径
 * 继续开旧库——迁移是优化不是功能闸，绝不让建索引/召回因此整体失败。
 */
export function resolveRagDbPath(bookRoot: string): string {
  const dbPath = newRagDbPath(bookRoot)
  const legacyPath = legacyRagDbPath(bookRoot)
  if (existsSync(dbPath) || !existsSync(legacyPath)) {
    // 新库已就位 / 从未建过库：统一走新路径（DatabaseSync 建文件前目录必须在）
    mkdirSync(join(bookRoot, '.cache'), { recursive: true })
    return dbPath
  }
  try {
    mkdirSync(join(bookRoot, '.cache'), { recursive: true })
    renameSync(legacyPath, dbPath)
  } catch {
    return legacyPath
  }
  // WAL 侧车（崩溃残留的 -wal/-shm）随主库一并迁走——主库已在新路径，侧车留在旧处
  // = WAL 里已提交的事务丢失。侧车迁不走不回滚也不改道（回落只会开出空库），尽力而为。
  for (const ext of ['-wal', '-shm']) {
    if (existsSync(legacyPath + ext)) {
      try {
        renameSync(legacyPath + ext, dbPath + ext)
      } catch {
        /* 见上：主库已迁，侧车失败无路可退 */
      }
    }
  }
  return dbPath
}

/** 打开 per-book RAG 库（.cache/rag.db，书仓库内派生缓存区） */
export function openRagDb(bookRoot: string): DatabaseSync {
  const db = new DatabaseSync(resolveRagDbPath(bookRoot))
  // P2-2：WAL 模式 + 忙等 5s，防并发写入 SQLITE_BUSY
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA busy_timeout = 5000')
  createRagTables(db)
  // A3（批 7）：norm 列惰性迁移 + 存量回填（幂等——列在/范数齐 → no-op）
  ensureNormColumn(db)
  return db
}

/** 向量 L2 范数（A3 预存范数：余弦退化为点积，召回数学量减半） */
export function l2Norm(vec: Float32Array): number {
  let sum = 0
  for (let i = 0; i < vec.length; i++) sum += vec[i]! * vec[i]!
  return Math.sqrt(sum)
}

/**
 * A3（批 7）：chunks.norm 列迁移——旧库无列 → ALTER TABLE 加列；有列但存 NULL
 * （加列后的存量行）→ 逐行算 L2 写回（一次性，打开库时自愈）。幂等：二次打开全
 * 值在位 → 零写。回填失败（锁/IO）上抛给 openRagDb 调用方（RAG 各入口已有降级）。
 */
export function ensureNormColumn(db: DatabaseSync): void {
  const cols = db.prepare('PRAGMA table_info(chunks)').all() as Array<{ name: string }>
  if (!cols.some((c) => c.name === 'norm')) {
    db.exec('ALTER TABLE chunks ADD COLUMN norm REAL')
  }
  const nullCount = (db.prepare('SELECT COUNT(*) AS n FROM chunks WHERE norm IS NULL').get() as { n: number }).n
  if (nullCount === 0) return
  const rows = db
    .prepare('SELECT id, embedding FROM chunks WHERE norm IS NULL')
    .all() as Array<{ id: number; embedding: Uint8Array }>
  const update = db.prepare('UPDATE chunks SET norm = ? WHERE id = ?')
  db.exec('BEGIN')
  try {
    for (const r of rows) {
      update.run(l2Norm(bufferToFloat32(r.embedding)), r.id)
    }
    db.exec('COMMIT')
  } catch (e) {
    db.exec('ROLLBACK')
    throw e
  }
}

/** 存一个块（embedding 序列化为 BLOB；A3 同步预算 L2 范数——余弦退化为点积）。
 *  V-P2-3：INSERT OR REPLACE——(章号, 偏移, 模型) 有唯一键，同块重写幂等不重复。 */
export function storeChunk(db: DatabaseSync, chunk: ChunkInput): void {
  const stmt = db.prepare(
    `INSERT OR REPLACE INTO chunks (章号, start_offset, end_offset, embedding, model, indexed_at, norm)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  )
  stmt.run(
    chunk.章号,
    chunk.start_offset,
    chunk.end_offset,
    float32ToBuffer(chunk.embedding),
    chunk.model,
    new Date().toISOString(),
    l2Norm(chunk.embedding),
  )
}

/**
 * 读全部块（召回用，全表线性扫描——#37 第 5 节）。
 * 规模量化（2026-08 实测，Apple Silicon，基准见 test/rag/scale.test.ts）：200 万字目标场景
 * 700 章 / 3.5 万块 / 1536 维（rag.db ~277MB）单次召回 ~320-350ms，含全表 BLOB 读回 +
 * 逐块余弦 + 700 章指纹校验；线性外推：1 万块 ~100ms、几千块几十 ms（原「单本几千块 ms 级」
 * 成立）。结论：十万块内线性扫描可用，超出或要求 <100ms 交互时再议 FTS/向量索引（RC，
 * 需先量化收益）——在界值测试退化失败前明确不引索引。
 */
export function readAllChunks(db: DatabaseSync): RagChunk[] {
  const stmt = db.prepare('SELECT id, 章号, start_offset, end_offset, embedding, norm, model, indexed_at FROM chunks')
  // 内存闸（2026-08-24）：改游标逐行读（iterate）——原 stmt.all() 先把全部 embedding
  // BLOB 物化成数组、再 map 复制出第二份 Float32Array，2 万+ 块 × 1536 维时单次召回
  // ~260MB 双份驻留（测试反复调 recall 叠加为 GB 级峰值）；逐行读每行 BLOB 用完即可
  // 回收，峰值约减半。语义不变：产出与原实现逐项一致。
  const out: RagChunk[] = []
  for (const r of stmt.iterate() as Iterable<{
    id: number; 章号: number; start_offset: number; end_offset: number
    embedding: Uint8Array; norm: number | null; model: string; indexed_at: string
  }>) {
    out.push({
      id: r.id,
      章号: r.章号,
      start_offset: r.start_offset,
      end_offset: r.end_offset,
      embedding: bufferToFloat32(r.embedding),
      norm: r.norm,
      model: r.model,
      indexed_at: r.indexed_at,
    })
  }
  return out
}

/** A3（批 7）：全部章指纹元数据一次读进内存（章号 → indexed hash）——惰性校验的
 *  元数据源（召回闭库后子集校验用；单 SELECT，零文件 IO）。 */
export function readAllChapterFingerprints(db: DatabaseSync): Map<number, string> {
  const rows = db
    .prepare("SELECT key, value FROM rag_meta WHERE key LIKE 'chapter_hash:%'")
    .all() as Array<{ key: string; value: string }>
  const out = new Map<number, string>()
  for (const r of rows) {
    const n = Number(r.key.slice('chapter_hash:'.length))
    if (Number.isFinite(n) && n > 0) out.set(n, r.value)
  }
  return out
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

/** 删 rag_meta 单键（P1-28：清理已删除章的指纹残留） */
export function deleteRagMeta(db: DatabaseSync, key: string): void {
  db.prepare('DELETE FROM rag_meta WHERE key = ?').run(key)
}

/** 删某章全部向量块（P1-28：已索引章被删后清理残留，防其向量继续参与召回） */
export function deleteChunksByChapter(db: DatabaseSync, 章号: number): void {
  db.prepare('DELETE FROM chunks WHERE 章号 = ?').run(章号)
}

/** 已索引过的章号集合（chunks 去重；P1-28 删除检测用） */
export function getIndexedChapterNumbers(db: DatabaseSync): number[] {
  const rows = db.prepare('SELECT DISTINCT 章号 FROM chunks').all() as Array<{ 章号: number }>
  return rows.map((r) => r.章号)
}

/**
 * 纯 JS 余弦相似度（#37 第 5 节，不引向量库）。
 * cos = dot(a,b) / (||a|| * ||b||)
 */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0
  // P3-14：长度已判等，Math.min 冗余
  const len = a.length
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
