/**
 * RAG 向量存取 —— 依据 M7 #37 spec 第 3/4/5 节。
 *
 * per-book RAG 库（.cache/rag.db）生命周期 + 向量 BLOB 序列化 + 余弦召回。
 * 纯 node:sqlite + 纯 JS 余弦（零依赖，不引向量索引库）。
 */

import { DatabaseSync } from 'node:sqlite'
import { existsSync, mkdirSync, renameSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { createRagTables } from './schema.js'
import { log } from '../log/index.js'

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

/** Float32Array ↔ Buffer（BLOB 序列化）。
 *  R31-36（三十一轮）登记维持：序列化按 TypedArray 本机字节序（现实宿主 x86/ARM
 *  全小端，无实害面）——显式 littleEndian 需换 DataView 并作废旧库向量（全部 rag.db
 *  重嵌一次），代价远超理论收益；若未来出现大端宿主跨架构迁移需求再立项。 */
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
    // R65-4（十三轮）：迁移前先 checkpoint——把 WAL 已提交事务并入主库文件，从根上消除
    // 「主库 rename 成功而 -wal 侧车迁走失败（EBUSY/杀软占用）→ 侧车里已提交事务丢失、
    // 新路径开出空库、全书重嵌入」的窗口。checkpoint 失败不阻断迁移（回落旧行为 +
    // 下方侧车告警兜底）。TRUNCATE 把 wal 清零后，侧车 rename 即使失败也已无数据可丢。
    try {
      const legacy = new DatabaseSync(legacyPath)
      try {
        legacy.exec('PRAGMA wal_checkpoint(TRUNCATE)')
      } finally {
        legacy.close()
      }
    } catch {
      /* checkpoint 尽力而为：失败回落纯 rename 迁移 */
    }
    renameSync(legacyPath, dbPath)
  } catch {
    // R71-36（总七十一轮）：双进程并发迁移竞态——败者的 rename 撞上胜者已迁移完成时
    // ENOENT，此前无条件回退 legacyPath 会在旧路径（已被胜者迁走）上让 DatabaseSync
    // 重新开出空库，跑完会话 + 残留孤儿库。先复查 dbPath：存在 ⇒ 胜者已迁移完成，
    // 改道用新库；仍不存在才是真未迁移（.cache 建不成等），回退旧路径
    if (existsSync(dbPath)) return dbPath
    return legacyPath
  }
  // WAL 侧车（崩溃残留的 -wal/-shm）随主库一并迁走——主库已在新路径，侧车留在旧处
  // = WAL 里已提交的事务丢失。侧车迁不走不回滚也不改道（回落只会开出空库），尽力而为。
  for (const ext of ['-wal', '-shm']) {
    if (existsSync(legacyPath + ext)) {
      try {
        renameSync(legacyPath + ext, dbPath + ext)
      } catch {
        // R65-4：不留静默回退——主库已迁而侧车滞留旧处时记 warn（checkpoint 失败 +
        // rename 失败双降级才会到这；日志至少能看到「迁移丢失」而非「未建过库」）
        // R66-10（十四轮）：console.warn → log 通道——Electron 生产环境 console 不被采集，
        // 迁移丢失线索必须落文件日志
        log.warn('rag', `迁移侧车失败（${ext}）：${legacyPath}${ext} 滞留旧处，WAL 内已提交数据可能丢失`)
      }
    }
  }
  return dbPath
}

/**
 * R35-13（三十五轮）：库级损坏识别——窄匹配 SQLITE_NOTADB（errcode 26）/ SQLITE_CORRUPT
 *（errcode 11，含扩展码取低 8 位）及其确定性 message 形态；BUSY(5)/IO(10)/约束等绝不
 * 误判为损坏（误判 + 删库 = 把可重试故障升级成整库重嵌）。有 errcode 时只认 errcode，
 * message 兜底仅用于无 errcode 的宿主差异。
 */
export function isRagDbCorruptionError(e: unknown): boolean {
  const err = e as { errcode?: unknown; message?: unknown }
  if (typeof err.errcode === 'number') {
    const primary = err.errcode & 0xff
    return primary === 26 || primary === 11
  }
  const msg = typeof err.message === 'string' ? err.message : ''
  return /file is not a database|database disk image is malformed/i.test(msg)
}

/**
 * R1W-11（win 平台专项复审 R1）：unlink 的 EPERM/EBUSY 瞬时占用退避（rename 侧
 * R65-4/R77-3 的删除侧同族补齐）——杀软/索引器对刚关闭的 db 文件瞬时锁定会让
 * deleteRagDbFiles 裸 unlink 抛错 → rebuild 自愈链 500 需人工重试。3×50ms 指数
 * 退避后仍失败原样上抛（调用方按失败收口，不静默吞）。unlink/sleep 可注入（测试用）。
 */
const RETRYABLE_UNLINK_CODES = new Set(['EPERM', 'EBUSY'])

export function unlinkWithRetry(
  fp: string,
  opts?: { unlink?: (p: string) => void; sleep?: (ms: number) => void; retries?: number; baseDelayMs?: number },
): void {
  const doUnlink = opts?.unlink ?? ((p: string) => unlinkSync(p))
  const sleep =
    opts?.sleep ?? ((ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms))
  const retries = opts?.retries ?? 3
  const base = opts?.baseDelayMs ?? 50
  let attempt = 0
  for (;;) {
    try {
      return doUnlink(fp)
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code ?? ''
      if (attempt >= retries || !RETRYABLE_UNLINK_CODES.has(code)) throw e
      sleep(base * 2 ** attempt)
      attempt++
    }
  }
}

/**
 * R35-13（三十五轮）：删除 RAG 库文件（连同 -wal/-shm 侧车）。文件级损坏（断电/磁盘
 * 故障/杀软半写后的非 SQLite 字节流）清表救不了，只能删库重建——.cache/rag.db 是派生
 * 缓存区（schema.ts 自述），可弃可重建语义下删库不丢真数据（重嵌成本除外）。调用方
 * 必须先经 isRagDbCorruptionError 确认损坏，绝不对 busy/IO 等可重试错误删库。
 * R1W-11：unlink 走 EPERM/EBUSY 退避（杀软瞬时锁不再直接 500）。
 */
export function deleteRagDbFiles(bookRoot: string): void {
  const dbPath = resolveRagDbPath(bookRoot)
  for (const suffix of ['', '-wal', '-shm']) {
    const fp = dbPath + suffix
    if (existsSync(fp)) unlinkWithRetry(fp)
  }
}

/** 打开 per-book RAG 库（.cache/rag.db，书仓库内派生缓存区） */
export function openRagDb(bookRoot: string): DatabaseSync {
  const db = new DatabaseSync(resolveRagDbPath(bookRoot))
  // win 适配（阶段 21 真机回归）：初始化语句在损坏库（SQLITE_NOTADB 等）上抛时必须
  // close 后再上抛——`new DatabaseSync` 对垃圾字节文件照样开成功（文件头惰性读取），
  // 句柄若泄漏，win 上 unlink/rm 全撞 EBUSY/EPERM（deleteRagDbFiles 删库自愈链、
  // 测试 afterEach 清理皆死）；posix unlink 虽可带句柄删除，fd 泄漏同样是伤。
  try {
    // P2-2：WAL 模式 + 忙等 5s，防并发写入 SQLITE_BUSY
    db.exec('PRAGMA journal_mode = WAL')
    db.exec('PRAGMA busy_timeout = 5000')
    createRagTables(db)
    // A3（批 7）：norm 列惰性迁移 + 存量回填（幂等——列在/范数齐 → no-op）
    ensureNormColumn(db)
  } catch (e) {
    try {
      db.close()
    } catch {
      /* 已被引擎自行关闭（如 NOTADB 后句柄失效）——尽力而为，原错误优先上抛 */
    }
    throw e
  }
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
 * R65-13（总六十五轮）：去掉「每次 open 都 COUNT 全表」判存在——直接 SELECT NULL 行
 *（无 NULL 时只读不开写事务，不再多扫一遍 COUNT）；回填事务改 BEGIN IMMEDIATE
 *（与 commitIndexBatch 口径一致——deferred BEGIN 到首个 UPDATE 才升写锁，并发开库
 * 仍有 SQLITE_BUSY 窗口；IMMEDIATE 在 busy_timeout 内排队拿写锁）。
 */
export function ensureNormColumn(db: DatabaseSync): void {
  const cols = db.prepare('PRAGMA table_info(chunks)').all() as Array<{ name: string }>
  if (!cols.some((c) => c.name === 'norm')) {
    try {
      db.exec('ALTER TABLE chunks ADD COLUMN norm REAL')
    } catch (e) {
      // R35-44（三十五轮）：双进程并发首升——PRAGMA 探测到 ALTER 之间他进程已加列，
      // 本进程 ALTER 撞 duplicate column 视为升级完成（幂等）；其他错误原样上抛
      if (!isDuplicateColumnError(e)) throw e
    }
  }
  const rows = db
    .prepare('SELECT id, embedding FROM chunks WHERE norm IS NULL')
    .all() as Array<{ id: number; embedding: Uint8Array }>
  if (rows.length === 0) return
  const update = db.prepare('UPDATE chunks SET norm = ? WHERE id = ?')
  db.exec('BEGIN IMMEDIATE')
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

/** R35-44：duplicate column 错误判定（node:sqlite message「duplicate column name: …」；
 *  窄匹配——其他 ALTER 失败如磁盘满/锁不上当） */
function isDuplicateColumnError(e: unknown): boolean {
  const msg = (e as { message?: unknown }).message
  return typeof msg === 'string' && /duplicate column/i.test(msg)
}

/** 存一个块（embedding 序列化为 BLOB；A3 同步预算 L2 范数——余弦退化为点积）。
 *  V-P2-3：INSERT OR REPLACE——(章号, 偏移, 模型) 有唯一键，同块重写幂等不重复。 */
export function storeChunk(db: DatabaseSync, chunk: ChunkInput): void {
  // R34D-32（三十四轮）：入库末道守卫——embedding 含非有限分量（Float32 溢出成
  // ±Infinity / NaN）即拒绝写入（fail-closed）：毒行一旦落库即永久（norm=∞、余弦
  // 恒 NaN 挤占 topK 且无告警）。commitIndexBatch 物化点已拦同款，此处为未来新
  // 入库路径兜底；抛错走调用方事务回滚（INDEX 写入失败已回滚可安全重跑口径）
  if (chunk.embedding.some((x) => !Number.isFinite(x))) {
    throw new Error('storeChunk: embedding 含非有限分量（Float32 溢出/NaN），拒绝入库')
  }
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
  // R35-40（三十五轮）：存量毒行读取闸——R34D-32 只防新写入，历史毒行召回时余弦恒
  // NaN/失真挤占 topK。两种毒形都剔 + 一次性 warn 留痕（不阻断）：
  // ① norm 非有限（按发现口径留防——node:sqlite 对非有限 REAL 绑定/读回都转 null，
  //    此形当前实际不可达，纯前向防御）；
  // ② norm=NULL 且 embedding 含非有限分量（**实际可达形态**：毒行的 l2Norm=±Inf，
  //    ensureNormColumn 回填时绑定 Inf→NULL 永久存不进，行态停留 NULL；召回侧对
  //    null norm 现算兜底得 ±Inf → 余弦 NaN/0）。全量逐维扫描太贵（热路径），只在
  //    norm=NULL 的稀行上扫——正常行零额外成本。norm=null 且向量干净不是毒：照常
  //    交召回侧现算兜底（见 index.ts）。
  let poisonRows = 0
  for (const r of stmt.iterate() as Iterable<{
    id: number; 章号: number; start_offset: number; end_offset: number
    embedding: Uint8Array; norm: number | null; model: string; indexed_at: string
  }>) {
    if (r.norm !== null && !Number.isFinite(r.norm)) {
      poisonRows++
      continue
    }
    const embedding = bufferToFloat32(r.embedding)
    if (r.norm === null && embedding.some((x) => !Number.isFinite(x))) {
      poisonRows++
      continue
    }
    out.push({
      id: r.id,
      章号: r.章号,
      start_offset: r.start_offset,
      end_offset: r.end_offset,
      embedding,
      norm: r.norm,
      model: r.model,
      indexed_at: r.indexed_at,
    })
  }
  if (poisonRows > 0) {
    log.warn('rag', `RAG 库含 ${poisonRows} 行毒向量块（历史 Float32 溢出入库：norm 非有限或 norm=NULL 且向量含非有限分量）——已剔除不参与召回，建议重建索引（POST /rag/rebuild）清根`)
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
export function cosineSimilarity(
  a: Float32Array,
  b: Float32Array,
  precomputed?: { normA?: number; normB?: number },
): number {
  if (a.length !== b.length) return 0
  // P3-14：长度已判等，Math.min 冗余
  const len = a.length
  // R31-34（三十一轮）：预存范数双全时走纯点积分派——召回热路径（index.ts）每次
  // 调用都传 precomputed，原循环仍无条件累加两份范数平方（每维 3 次乘加当 1 次用，
  // A3/R64-45 宣称的「数学量减半」从未兑现，3.5 万块×1536 维/召回 ≈ 白做 1 亿次
  // 浮点）；预存缺失（校准/单测直调）回落全算，语义不变。
  const hasPre = typeof precomputed?.normA === 'number' && typeof precomputed?.normB === 'number'
  let dot = 0
  let normA = 0
  let normB = 0
  if (hasPre) {
    for (let i = 0; i < len; i++) dot += a[i]! * b[i]!
    normA = precomputed!.normA!
    normB = precomputed!.normB!
  } else {
    for (let i = 0; i < len; i++) {
      dot += a[i]! * b[i]!
      normA += a[i]! * a[i]!
      normB += b[i]! * b[i]!
    }
  }
  // R64-45（十二轮）：召回侧（index.ts）此前内联同逻辑且按块缓存范数——合流单源。
  // precomputed 传**最终 L2 范数**（l2Norm 口径，已开方）；缺省现算，语义与全量余弦一致。
  const na = hasPre ? normA : Math.sqrt(normA)
  const nb = hasPre ? normB : Math.sqrt(normB)
  const denom = na * nb
  return denom === 0 ? 0 : dot / denom
}
