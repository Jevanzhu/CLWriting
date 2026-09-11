/**
 * RAG 向量存取 —— 依据 M7 #37 spec 第 3/4/5 节。
 *
 * per-book RAG 库（.cache/rag.db）生命周期 + 向量 BLOB 序列化 + 余弦召回。
 * 纯 node:sqlite + 纯 JS 余弦（零依赖，不引向量索引库）。
 */

import { DatabaseSync, type StatementSync } from 'node:sqlite'
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
        // R0912-G1-P3-1（2026-09-12 独立重评修复批）：close 收编 closeRagDb——迁移探测
        // 库虽未走 prepared() 入缓存，但统一走带缓存注销的关库 helper（同文件 R0911-G-P3-4
        // 纪律：RAG 库的 close 一律不走裸 db.close()），防未来此段引入 prepared 调用时
        // 裸 close 重新打开 ephemeron 环泄漏面
        closeRagDb(legacy)
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

/** unlink 退避的可重试错误码（deleteRagDbFiles 用）：EPERM/EBUSY + EACCES
 * （R37-39，win FAT 权限变体）；ENOENT 不进重试面——R0912-G1-P3-7 起视为删除
 * 已成功（目标状态达成），其余确定性错误零重试原样上抛。 */
const RETRYABLE_UNLINK_CODES = new Set(['EPERM', 'EBUSY', 'EACCES'])

/**
 * R35-13（三十五轮）：删除 RAG 库文件（连同 -wal/-shm 侧车）。文件级损坏（断电/磁盘
 * 故障/杀软半写后的非 SQLite 字节流）清表救不了，只能删库重建——.cache/rag.db 是派生
 * 缓存区（schema.ts 自述），可弃可重建语义下删库不丢真数据（重嵌成本除外）。调用方
 * 必须先经 isRagDbCorruptionError 确认损坏，绝不对 busy/IO 等可重试错误删库。
 *
 * R37-39（三十七轮）/ R1W-11（win 平台专项复审 R1）双线同旨合并——unlink 的
 * EBUSY/EPERM/EACCES 小退避重试：win 杀毒/索引器瞬时占用 .cache/rag.db 时
 * unlinkSync 直接上抛会把删库自愈链变 500（瞬时占用毫秒级即释放）。本函数取
 * R37-39 实现：3 次重试 × 200ms 固定间隔，本函数在 resetRagIndex 同步链上
 *（DatabaseSync 同步 API，不可异步化），同步退避先例同 fs/atomic.ts
 * renameWithRetry（Atomics.wait 微睡 + unlink/sleep 可注入测试口，不动生产语义）。
 * 仅瞬时占用码进重试——R0912-G1-P3-7（2026-09-12 独立重评修复批）：ENOENT 视为
 * 已成功（existsSync 探测与 unlink 之间的 TOCTOU 窗口内文件被并发删掉 = 删除目标
 * 已达成，不再误报失败；确定性错误照旧不放宽重试）；其余确定性错误立即上抛。
 * 最终仍失败抛带结构化信息的
 * 错误（文件名+code+已重试次数），上层 isRagDbCorruptionError/rebuild 自愈语义
 * 不变（错误不落损坏判定面）。
 */
export interface DeleteRagDbFilesOptions {
  unlink?: (fp: string) => void
  sleep?: (ms: number) => void
  retries?: number
  delayMs?: number
}

export function deleteRagDbFiles(bookRoot: string, opts?: DeleteRagDbFilesOptions): void {
  const doUnlink = opts?.unlink ?? ((fp: string) => unlinkSync(fp))
  // Atomics.wait 同步微睡（Node 主线程合法；单次退避 200ms，不阻塞事件循环可观时长）
  const sleep =
    opts?.sleep ?? ((ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms))
  const retries = opts?.retries ?? 3
  const delayMs = opts?.delayMs ?? 200
  const dbPath = resolveRagDbPath(bookRoot)
  for (const suffix of ['', '-wal', '-shm']) {
    const fp = dbPath + suffix
    if (!existsSync(fp)) continue
    for (let attempt = 0; ; attempt++) {
      try {
        doUnlink(fp)
        break
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code ?? ''
        // R0912-G1-P3-7：ENOENT = 文件已不在（并发删除赢过了 existsSync 探测的
        // TOCTOU 窗口）→ 删除目标已达成，视为成功 break（不重试不抛）；其他
        // 确定性错误零重试原样上抛（先例同 renameWithRetry）
        if (code === 'ENOENT') break
        if (!RETRYABLE_UNLINK_CODES.has(code)) throw e
        if (attempt >= retries) {
          // R37-39：重试耗尽的结构化收口（文件名+code+已重试次数）
          throw new Error(
            `删除 RAG 库文件失败（${fp}，${code}，已重试 ${retries} 次）：文件被占用或权限不足，请关闭占用程序后重试重建索引`,
          )
        }
        sleep(delayMs)
      }
    }
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
    // R0910-W（2026-09-10 修复批）：norm 回填探测的部分索引——ensureNormColumn 每次 open
    // 都跑 `SELECT id, embedding FROM chunks WHERE norm IS NULL`，norm 无索引时全表扫
    //（约 3.5 万块/书），回填完成后（无 NULL 行）仍每次全扫；recallDetailed 一次召回开
    // 库两次，放大为 2× 全表扫。部分索引只收录 norm IS NULL 的行（正常为空），探测降为
    // 索引扫描。**须在 ensureNormColumn 之后**——旧库首次打开时 chunks 尚在 ALTER 之前，
    // 先建索引会撞 no such column: norm（createRagTables 的建表对既有旧表是 no-op）；
    // 首次打开仍免不了全扫（列刚加、全行 NULL，必须回填），此后各次 open 走索引不再全扫。
    // 新建索引对既有库为一次 O(n) 迁移（IF NOT EXISTS 幂等）。新写入行由 storeChunk 即时
    // 算 norm，不会长期滞留 NULL（异常行由召回侧现算兜底）。
    db.exec('CREATE INDEX IF NOT EXISTS idx_chunks_norm_null ON chunks(id) WHERE norm IS NULL')
  } catch (e) {
    try {
      closeRagDb(db)
    } catch {
      /* 已被引擎自行关闭（如 NOTADB 后句柄失效）——尽力而为，原错误优先上抛 */
    }
    throw e
  }
  return db
}

// ── R46-45（四十六轮）：连接级 prepared 语句缓存 ─────────────────────────
// 与 events/store.ts R46-42 同手法（模块独立性优先，本文件内自持一份小帮手）：
// node:sqlite 的 db.prepare 每次重编译同一条 SQL——全书重建索引 3.5 万次 storeChunk
// 即 3.5 万次编译同一 INSERT，纯白付。按 db 实例（WeakMap 键）+ SQL 串双键缓存编译
// 产物。建库/迁移/探测类一次性语句（DDL、PRAGMA、checkpoint、存在性探测）不走本帮手。
// R0912-G1-P3-1（2026-09-12 独立重评修复批）：头注修账——原句「连接 close 后条目随
// GC 消失，无悬挂执行面」失实：node:sqlite 的 StatementSync 强引用其 DatabaseSync，
// 本缓存 WeakMap<db, Map<sql, stmt>> 的值侧 Map → stmt → db 与弱键构成 ephemeron 环，
// close 并不解除该强引用、条目不随 GC 消失（R0911-G-P3-4 实测：裸 .mjs 40k 次
// open/close 每次滞留 ~0.35KB，30k 次线性增长）。必须经 closeRagDb 先 delete 断链
// 再 close——故本帮手与 closeRagDb 是配对纪律：凡有 prepared 调用面的连接，关库
// 一律走 closeRagDb，不得裸 db.close()。
const preparedByDb = new WeakMap<DatabaseSync, Map<string, StatementSync>>()

/** R46-45：按 (db, sql) 取缓存的 prepared 语句；未见过则编译一次入缓存。 */
function prepared(db: DatabaseSync, sql: string): StatementSync {
  let bySql = preparedByDb.get(db)
  if (bySql === undefined) {
    bySql = new Map()
    preparedByDb.set(db, bySql)
  }
  let stmt = bySql.get(sql)
  if (stmt === undefined) {
    stmt = db.prepare(sql)
    bySql.set(sql, stmt)
  }
  return stmt
}

/**
 * R0911-G-P3-4（2026-09-11 重评修复批）：带缓存注销的关库——RAG 库的 close 一律走本
 * helper，不得裸 `db.close()`。根因（裸 .mjs 40k 次 open/close 复现定位）：node:sqlite
 * 的 StatementSync 强引用其 DatabaseSync，R46-45 的 preparedByDb（WeakMap<db, Map<sql,
 * stmt>>）值侧 Map → stmt → db 与弱键构成 ephemeron 环，db 关闭后条目不随 GC 消失——
 * 每次开/关滞留一份 Map+语句包装（实测 ~0.35KB；语句是否执行过无关，仅入缓存即滞留）。
 * RAG 召回每次开库两回（探测+读），长会话下线性堆积；close 前显式 delete 断链后实测
 * 归零（30k 次开/关增长 0.00MB）。WAL/busy_timeout/table_info/部分索引均经 bisect 排除。
 */
export function closeRagDb(db: DatabaseSync): void {
  preparedByDb.delete(db)
  db.close()
}

/**
 * R0912-G1-P3-3（2026-09-12 独立重评修复批）：安全回滚——SQLite 部分错误
 *（SQLITE_FULL/IOERR 等）已自动回亡事务，再 ROLLBACK 抛 "no transaction is
 * active" 会掩蔽原始错误；吞 ROLLBACK 自身异常、调用方继续走自己的原始错误
 * 上抛/返回文案。本文件与 index.ts 共五处同构 try{ROLLBACK}catch{} 收编单源
 *（各处原注释并入本头注：store.ts ensureNormColumn R43-18、index.ts
 * resetRagIndex / buildIndex 清残留 / commitIndexBatch 续传小事务 / 主提交事务
 * 均 R43-18（四十三轮）R61-10 同款加固）。无事务（began=false 等）时调用无害。
 */
export function safeRollback(db: DatabaseSync): void {
  try {
    db.exec('ROLLBACK')
  } catch {
    /* 已自动回亡 */
  }
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
 * R46-51（四十六轮）：NULL 行集改 stmt.iterate() 游标逐行（readAllChunks R37-38/
 * 内存闸同款降峰先例）——原 .all() 先把全部待回填行（含 embedding BLOB，200 万字
 * 书 3.5 万块 × 6KB ≈ 200MB 级）整表物化后才开写，迁移窗内峰值驻留白付；逐行读
 * 每行 BLOB 用完即可回收。游标内 UPDATE 已过行不回访：表按 rowid 序扫，UPDATE 保
 * rowid 原位、被改行已落在游标身后（再访也被 WHERE norm IS NULL 滤掉）；行级 UPDATE
 * 语句并入 R46-45 prepared 缓存（固定 SQL，循环外取一次）。
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
  const rows = prepared(db, 'SELECT id, embedding FROM chunks WHERE norm IS NULL')
    .iterate() as unknown as Iterable<{ id: number; embedding: Uint8Array }>
  const update = prepared(db, 'UPDATE chunks SET norm = ? WHERE id = ?')
  // R65-13：首行才开写事务（无 NULL 行 → 只读不开 BEGIN IMMEDIATE）；R46-51：for...of
  // 游标逐行（break/异常路径自动收口迭代器，readAllChunks 同款）
  let began = false
  try {
    for (const r of rows) {
      if (!began) {
        db.exec('BEGIN IMMEDIATE')
        began = true
      }
      update.run(l2Norm(bufferToFloat32(r.embedding)), r.id)
    }
    if (began) db.exec('COMMIT')
  } catch (e) {
    // R43-18（四十三轮）：R61-10 同款加固（events/store.ts 模板）——SQLite 部分错误
    //（SQLITE_FULL/IOERR 等）已自动回亡事务，再 ROLLBACK 抛 "no transaction is
    // active" 掩蔽原始写错误；吞 ROLLBACK 自身异常、原样上抛。began=false（首行
    // 读/开事务前抛）无事务可回，跳过。
    // R0912-G1-P3-3：回滚句收编 safeRollback 单源。
    if (began) safeRollback(db)
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
  // R46-45：全书重建 3.5 万次调用的 INSERT 走连接级 prepared 缓存（原每块重编译一次）
  const stmt = prepared(
    db,
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
 * 读全部块（全表线性扫描——#37 第 5 节）。
 * R49-19（四十九轮）：头注如实化——生产召回自 R46-9 起走 streamChunkScores（流式打分，
 * 向量 BLOB 用完即弃），本函数 src 内零生产调用方，现存消费面仅测试（断言/盘点原语）；
 * 勿再把它接回召回热路径。
 * R37-38（三十七轮）：可选 maxChunks 早停——产出行数达到限额即停（毒行剔除不计额），
 * 语义恒等于全量读后 slice(0, maxChunks)；缺省 undefined = 全读（既有口径不变）。
 * 规模量化（2026-08 实测，Apple Silicon，基准见 test/rag/scale.test.ts）：200 万字目标场景
 * 700 章 / 3.5 万块 / 1536 维（rag.db ~277MB）单次召回 ~320-350ms，含全表 BLOB 读回 +
 * 逐块余弦 + 700 章指纹校验；线性外推：1 万块 ~100ms、几千块几十 ms（原「单本几千块 ms 级」
 * 成立）。结论：十万块内线性扫描可用，超出或要求 <100ms 交互时再议 FTS/向量索引（RC，
 * 需先量化收益）——在界值测试退化失败前明确不引索引。
 */
export function readAllChunks(db: DatabaseSync, maxChunks?: number): RagChunk[] {
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
    // R37-38（三十七轮）：maxChunks 早停——产出行数达到限额即停，不再把全表 chunk
    // 读进内存（召回调用方只为截断告警时传「告警阈值+1」即够判 truncated，大库数万
    // 行白读）。语义恒等于全量读后 slice(0, maxChunks)，两个前提：
    // ① 行序一致：无 ORDER BY 时 iterate 行序 = rowid 序 = 插入序（SQLite 扫表序），
    //    早停取到的恰是全量读的前缀；
    // ② 限额只数**产出行**（毒行剔除不计额）——slice 作用在剔毒后的数组上，早停
    //    计数口径必须同为剔毒后。副作用：早停时未读尾段的毒行不计入 warn 计数
    //    （留痕只覆盖已读前缀，截断语义本就丢弃尾段，可接受）。
    // 边界：maxChunks=0/负数 → 直接空（首行即停，零产出）；undefined → 全读（既有
    // 调用方/测试面口径不变）。
    if (maxChunks !== undefined && out.length >= maxChunks) break
    if (r.norm !== null && !Number.isFinite(r.norm)) {
      poisonRows++
      continue
    }
    const embedding = bufferToFloat32(r.embedding)
    // R1010b-CHK-P3-1（2026-09-10 内存专项重审修复批）：BLOB 字节数非 4 倍数/空 BLOB
    // → bufferToFloat32 返回空数组。此形外部损坏才可达（storeChunk 写入侧恒 Float32Array，
    // 序列化字节数恒 4 倍数），此前 norm 非 null 的损坏行跳过两个毒形分支照常产出、
    // 下游按「维度不匹配」记账（totalBlocks 虚增、永不触发毒行 warn，作者得不到重建
    // 索引指引）。归毒行剔除（norm 两态都剔——norm=null 空向量本就无有效分量，同损坏），
    // 沿用既有毒行告警口径。
    if (embedding.length === 0) {
      poisonRows++
      continue
    }
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

/** R46-9（四十六轮）：流式召回扫描的轻量命中元组（不含 embedding——余弦算完即弃）。 */
export interface ChunkScoreRow {
  章号: number
  start_offset: number
  end_offset: number
  score: number
}

/**
 * R46-9（四十六轮）：召回的流式打分扫描——逐行读 chunks、当场算余弦、只保留轻量
 * 元组（embedding BLOB 用完即可回收），替代「readAllChunks 全量读回 → 全池驻留」。
 * 内存峰值 O(产出元组 × ≈40B)：10 万块截断档 ≈4MB（此前全池向量 590-615MB 跨
 * embed 网络窗（≤30s）驻留，2-3 路并发召回即 OOM/长 GC 风险——100K 阈值的内存账
 * 随延迟账一并入注，见 index.ts R46-9）。
 *
 * 语义与旧链路「readAllChunks(maxRows) → filter(model/维度) → map 余弦（R64-45
 * 单源 + 预存范数兜底）→ 稳定 sort」逐位等价：
 * - 行序同为无 ORDER BY 的 rowid 扫表序；元组按行序追加（调用方 sort 的并列分数
 *   次序与旧数组稳定排序一致）；
 * - 毒行剔除不计产出额（R37-38 早停口径一致，毒行 warn 由调用方按计数留痕）；
 * - model/维度不匹配行计入 produced（totalBlocks 口径不变）但不产元组；
 * - maxRows 语义 = 产出行数上限（探针行含在产出内，截断剔除由调用方 pop）。
 *   R49-20（评审 R49）：produced 计数先于 model/维度过滤——探针行（第 maxRows 个
 *   产出行）可以是不匹配行而**不入 rows**，故附 `lastProducedWasMatch` 供调用方
 *   精确剔除（仅当最后产出行确为命中才 pop，不得盲 pop）。
 */
export function streamChunkScores(
  db: DatabaseSync,
  queryVec: Float32Array,
  model: string,
  maxRows: number,
): { rows: ChunkScoreRow[]; produced: number; poisonRows: number; lastProducedWasMatch: boolean } {
  // R0912-G1-P3-2（2026-09-12 独立重评修复批）：召回热路径 SELECT 走 prepared 缓存
  //（每次召回都重编译同一全表扫描语句，纯白付；原 db.prepare 改同文件既有 helper）
  const stmt = prepared(db, 'SELECT 章号, start_offset, end_offset, embedding, norm, model FROM chunks')
  const qNorm = l2Norm(queryVec)
  const rows: ChunkScoreRow[] = []
  let produced = 0
  let poisonRows = 0
  // R49-20：最后一条产出行是否为 model/维度匹配行（真入 rows）——不匹配行只计数
  // 不产元组，截断态下调用方据本标记判定探针行是否占位 rows
  let lastProducedWasMatch = false
  for (const r of stmt.iterate() as Iterable<{
    章号: number; start_offset: number; end_offset: number
    embedding: Uint8Array; norm: number | null; model: string
  }>) {
    if (produced >= maxRows) break
    if (r.norm !== null && !Number.isFinite(r.norm)) {
      poisonRows++
      continue
    }
    const embedding = bufferToFloat32(r.embedding)
    // R1010b-CHK-P3-1（2026-09-10 内存专项重审修复批）：同 readAllChunks——BLOB 字节数
    // 非 4 倍数/空 BLOB（外部损坏才可达，storeChunk 写入侧恒 Float32Array）→ 空数组归
    // 毒行剔除。必须在 produced++ 之前判：毒行不占产出名额（R37-38 剔毒不计额、R49-20
    // 探针行口径一致），否则损坏行占 produced 被下游按「维度不匹配」记账（totalBlocks
    // 虚增、poisonRows 恒 0 永不触发调用方毒行 warn）。fail-closed 不变：损坏行本就因
    // 维度失配不进 rows，改判毒行后仍不进。
    if (embedding.length === 0) {
      poisonRows++
      continue
    }
    if (r.norm === null && embedding.some((x) => !Number.isFinite(x))) {
      poisonRows++
      continue
    }
    produced++
    if (r.model !== model || embedding.length !== queryVec.length) {
      lastProducedWasMatch = false
      continue
    }
    // R64-45 同款：预存范数复用，norm 异常缺失现算兜底
    const cNorm = r.norm !== null && r.norm > 0 ? r.norm : l2Norm(embedding)
    rows.push({
      章号: r.章号,
      start_offset: r.start_offset,
      end_offset: r.end_offset,
      score: cosineSimilarity(queryVec, embedding, { normA: qNorm, normB: cNorm }),
    })
    lastProducedWasMatch = true
  }
  return { rows, produced, poisonRows, lastProducedWasMatch }
}

/** A3（批 7）：全部章指纹元数据一次读进内存（章号 → indexed hash）——惰性校验的
 *  元数据源（召回闭库后子集校验用；单 SELECT，零文件 IO）。 */
export function readAllChapterFingerprints(db: DatabaseSync): Map<number, string> {
  // R0912-G1-P3-2：召回热路径（每次召回读指纹元数据）走 prepared 缓存
  const rows = prepared(db, "SELECT key, value FROM rag_meta WHERE key LIKE 'chapter_hash:%'")
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
  // R46-45：固定 SQL 走 prepared 缓存
  const stmt = prepared(db, 'SELECT value FROM rag_meta WHERE key = ?')
  const row = stmt.get(key) as { value: string } | undefined
  return row?.value ?? null
}

export function setRagMeta(db: DatabaseSync, key: string, value: string): void {
  // R46-45：同上
  const stmt = prepared(db, 'INSERT OR REPLACE INTO rag_meta (key, value) VALUES (?, ?)')
  stmt.run(key, value)
}

/** 删 rag_meta 单键（P1-28：清理已删除章的指纹残留） */
export function deleteRagMeta(db: DatabaseSync, key: string): void {
  // R46-45：同上
  prepared(db, 'DELETE FROM rag_meta WHERE key = ?').run(key)
}

/** 删某章全部向量块（P1-28：已索引章被删后清理残留，防其向量继续参与召回） */
export function deleteChunksByChapter(db: DatabaseSync, 章号: number): void {
  // R46-45：同上
  prepared(db, 'DELETE FROM chunks WHERE 章号 = ?').run(章号)
}

/** 已索引过的章号集合（chunks 去重；P1-28 删除检测用） */
export function getIndexedChapterNumbers(db: DatabaseSync): number[] {
  // R0912-G1-P3-2：召回/建索引探测热路径走 prepared 缓存
  const rows = prepared(db, 'SELECT DISTINCT 章号 FROM chunks').all() as Array<{ 章号: number }>
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
