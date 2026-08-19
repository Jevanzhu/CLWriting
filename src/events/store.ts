/**
 * F1 事件库存取层（node:sqlite，F1 方案 §三）。
 *
 * 落址：<userData>/clwriting/session/<bookHash>.db，每书一库；书库目录零改动。
 * bookHash = sha256(bookRoot) 前 16 hex（稳定，书路径不变则库不变）。
 *
 * 写入纪律（F1 §三）：每批一个事务；先落库后返回；启动修复补孤儿 session 的
 * closers；WAL + busy_timeout 防并发写 SQLITE_BUSY。
 *
 * 同步 API（node:sqlite DatabaseSync，同 rag/store.ts 模式）。
 */
import { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import { mkdirSync, existsSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { ulid } from '../document/stable-id.js'
import type { ChatEvent, SurfaceOp } from './types.js'

/** 书 hash：sha256(bookRoot) 前 16 hex——稳定，不落原文路径 */
export function bookHash(bookRoot: string): string {
  return createHash('sha256').update(bookRoot).digest('hex').slice(0, 16)
}

export interface SessionRow {
  session_id: string
  format_version: number
  book: string
  header: string
  created_at: number
  updated_at: number
}

export type NewEvent = Omit<ChatEvent, 'seq' | 'sessionId' | 'createdAt' | 'replaceGeneration'>

export interface SessionStore {
  dbPath: string
  createSession(book: string, header?: Record<string, unknown>): string
  /** 落库一批事件，返回数据库真实分配的 seq 数组（与 events 一一对应）。
   *  RB-IF-P1-2：compaction 事件的 sourceSeqs 是全局 seq（遮蔽区间），不走
   *  appendEventsResolveLineage 的批内索引解析——由本方法原样落库并返回真实 seq。 */
  appendEvents(sessionId: string, events: NewEvent[]): number[]
  /** AA-P3-7：落库并返回真实分配的 seq（INSERT RETURNING，单事务内回写血缘）。
   *  events 的 sourceSeqs 按「批内序号」（0-based，同批前驱引用）传入；返回 seq 数组与
   *  events 一一对应。血缘推算不再依赖 lastSeq()+批内序号（多窗口并发写时可错链）。 */
  appendEventsResolveLineage(sessionId: string, events: NewEvent[]): number[]
  appendEvent(sessionId: string, ev: NewEvent): number
  listEvents(book: string, sessionId?: string): ChatEvent[]
  /** P2：每书一个 workspace 会话（ws- 前缀）承载非对话链路事件（step/llm/retry/check）；惰性创建复用 */
  workspaceSession(book: string): string
  latestSession(book: string): SessionRow | null
  /** 当前库最大 seq（recorder 算写入区间用） */
  lastSeq(): number
  clearBook(book: string): void
  close(): void
}

interface Row {
  seq: number; session_id: string; turn: number | null; step: number | null;
  type: string; data: string; surface_op: string | null;
  shadow_start: number | null; shadow_end: number | null;
  source_seqs: string | null; replace_generation: number; created_at: number;
}

function rowToEvent(r: Row): ChatEvent {
  return {
    seq: r.seq,
    sessionId: r.session_id,
    turn: r.turn ?? undefined,
    step: r.step ?? undefined,
    type: r.type as ChatEvent['type'],
    data: JSON.parse(r.data) as Record<string, unknown>,
    surfaceOp: (r.surface_op as SurfaceOp | null) ?? undefined,
    shadowStart: r.shadow_start ?? undefined,
    shadowEnd: r.shadow_end ?? undefined,
    sourceSeqs: r.source_seqs ? (JSON.parse(r.source_seqs) as number[]) : undefined,
    replaceGeneration: r.replace_generation,
    createdAt: r.created_at,
  }
}

/** 孤儿会话补 end 的宽限期：最后活动距今不足该值视为「可能仍在进行」，不补（RB-IF-P2-2） */
const ORPHAN_GRACE_MS = 10 * 60 * 1000

/** 启动修复：孤儿 session（有 session/start 无 session/end）补 closers。
 *  Y-P1-1：跳过本进程活跃会话（SessionRecorder 登记中）——修复只面向崩溃残留，
 *  不得给进行中的会话插 session/end（否则审计流出现虚假中断）。
 *  RB-IF-P2-2：进程内 Set 看不见跨进程写方（dev-api/脚本与 app 并行开同库）——
 *  加宽限期，按会话最后事件的 created_at 判断；距今不足阈值/拿不到时间 → 保守不补。 */
function repairOrphanSessions(db: DatabaseSync, skip: ReadonlySet<string>): void {
  const stmt = db.prepare(
    `SELECT e.session_id,
            SUM(CASE WHEN e.type = 'session/start' THEN 1 ELSE 0 END) AS starts,
            SUM(CASE WHEN e.type = 'session/end' THEN 1 ELSE 0 END) AS ends,
            MAX(e.created_at) AS last_at
     FROM events e
     WHERE e.session_id IN (SELECT DISTINCT session_id FROM events WHERE type = 'session/start')
     GROUP BY e.session_id`
  );
  const orphans = stmt.all() as Array<{ session_id: string; starts: number; ends: number; last_at: number | null }>
  const ins = db.prepare(
    `INSERT INTO events (session_id, type, data, replace_generation, created_at)
     VALUES (?, 'session/end', ?, 0, ?)`
  );
  const now = Date.now()
  for (const o of orphans) {
    if (o.starts > o.ends && !skip.has(o.session_id)) {
      // 新近活跃（可能是另一进程进行中的会话）或时间不可得 → 不补虚假 end
      if (o.last_at === null || now - o.last_at < ORPHAN_GRACE_MS) continue
      ins.run(o.session_id, JSON.stringify({ reason: 'interrupted' }), now)
    }
  }
}

// ── Y-P1-1/Y-P2-6：进程内连接单例（引用计数）+ 活跃会话登记 ──
// 此前每次 openSessionStore 都重跑 mkdir+PRAGMA+DDL×2+全表修复聚合（一次自愈写章
// 十次级连接开关），且修复会在活跃会话进行中注入虚假 session/end。现按 dbPath
// 缓存连接：缓存命中只计引用；close() 为「释放引用」，归零才真关库+清缓存。
// DDL 与孤儿修复只在首次打开（或归零重开后）执行一次。
interface StoreEntry {
  store: SessionStore
  refs: number
  closed: boolean
}
const openStores = new Map<string, StoreEntry>()
const activeChatSessions = new Set<string>()

/** 登记/注销本进程活跃对话会话（SessionRecorder 构造/收尾调用；孤儿修复跳过） */
export function registerActiveChatSession(sessionId: string): void {
  activeChatSessions.add(sessionId)
}
export function unregisterActiveChatSession(sessionId: string): void {
  activeChatSessions.delete(sessionId)
}

/**
 * 打开本书事件库（userDataPath 为空 → null，调用方退化内存模式）。
 * 进程内按 dbPath 单例（引用计数）：命中直接复用；首次建目录 + DDL + 启动修复。
 */
export function openSessionStore(userDataPath: string | null | undefined, bookRoot: string): SessionStore | null {
  if (!userDataPath) return null
  const dir = join(userDataPath, 'clwriting', 'session')
  const dbPath = join(dir, bookHash(bookRoot) + '.db')
  const cached = openStores.get(dbPath)
  if (cached && !cached.closed) {
    cached.refs++
    return cached.store
  }
  mkdirSync(dir, { recursive: true })
  const db = new DatabaseSync(dbPath)
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA busy_timeout = 5000')
  db.exec(
    `CREATE TABLE IF NOT EXISTS events (
      seq         INTEGER PRIMARY KEY,
      session_id  TEXT NOT NULL,
      turn        INTEGER,
      step        INTEGER,
      type        TEXT NOT NULL,
      data        TEXT NOT NULL,
      surface_op  TEXT,
      shadow_start INTEGER,
      shadow_end   INTEGER,
      source_seqs  TEXT,
      replace_generation INTEGER NOT NULL DEFAULT 0,
      created_at   INTEGER NOT NULL
    )`
  );
  db.exec('CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id, seq)')
  db.exec(
    `CREATE TABLE IF NOT EXISTS sessions (
      session_id TEXT PRIMARY KEY,
      format_version INTEGER NOT NULL DEFAULT 1,
      book        TEXT NOT NULL,
      header      TEXT NOT NULL,
      created_at  INTEGER NOT NULL,
      updated_at  INTEGER NOT NULL
    )`
  );

  repairOrphanSessions(db, activeChatSessions)

  const entry: StoreEntry = { store: null!, refs: 1, closed: false }
  const store: SessionStore = {
    dbPath,
    createSession(book: string, header?: Record<string, unknown>): string {
      const sid = ulid()
      const now = Date.now()
      db.prepare(
        `INSERT INTO sessions (session_id, format_version, book, header, created_at, updated_at)
         VALUES (?, 1, ?, ?, ?, ?)`
      ).run(sid, book, JSON.stringify(header ?? {}), now, now)
      return sid
    },
    appendEvents(sessionId: string, evs: NewEvent[]): number[] {
      const now = Date.now()
      // RB-IF-P1-2：INSERT RETURNING 取真实 seq——close() 写 compaction 事件后据此
      // 定位 archiveSeq，不再 lastSeq()+2 推算（多窗口并发写时可错链到别窗事件）
      const ins = db.prepare(
        `INSERT INTO events (session_id, turn, step, type, data, surface_op, shadow_start, shadow_end, source_seqs, replace_generation, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?) RETURNING seq`
      );
      const touch = db.prepare('UPDATE sessions SET updated_at = ? WHERE session_id = ?')
      // P3-9：sessions.updated_at 挪进主事务——此前在 COMMIT 之后单独 UPDATE，若失败会
      // 误报「写失败」且客户端重试产生重复事件；现在与事件落库同事务，要么都成功要么都回滚。
      db.exec('BEGIN')
      try {
        const seqs: number[] = []
        for (const e of evs) {
          const row = ins.get(sessionId, e.turn ?? null, e.step ?? null, e.type, JSON.stringify(e.data),
            e.surfaceOp ?? null, e.shadowStart ?? null, e.shadowEnd ?? null,
            e.sourceSeqs ? JSON.stringify(e.sourceSeqs) : null, now) as { seq: number }
          seqs.push(row.seq)
        }
        touch.run(now, sessionId)
        db.exec('COMMIT')
        return seqs
      } catch (err) {
        db.exec('ROLLBACK')
        throw err
      }
    },
    // AA-P3-7：INSERT RETURNING 取真实 seq，sourceSeqs 批内索引同事务回写解析——
    // 血缘不再依赖 lastSeq()+批内序号推算（多窗口并发写事件库时可能错链到别窗的 seq）
    appendEventsResolveLineage(sessionId: string, evs: NewEvent[]): number[] {
      const now = Date.now()
      const ins = db.prepare(
        `INSERT INTO events (session_id, turn, step, type, data, surface_op, shadow_start, shadow_end, source_seqs, replace_generation, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, 0, ?) RETURNING seq`
      )
      const upd = db.prepare('UPDATE events SET source_seqs = ? WHERE session_id = ? AND seq = ?')
      const touch = db.prepare('UPDATE sessions SET updated_at = ? WHERE session_id = ?')
      db.exec('BEGIN')
      try {
        const seqs: number[] = []
        for (const e of evs) {
          const row = ins.get(
            sessionId, e.turn ?? null, e.step ?? null, e.type, JSON.stringify(e.data),
            e.surfaceOp ?? null, e.shadowStart ?? null, e.shadowEnd ?? null, now,
          ) as { seq: number }
          seqs.push(row.seq)
        }
        // 血缘回写：批内序号（0-based 同批前驱引用）→ 真实全局 seq，与插入同事务。
        // hh §八-18：越界索引 = 生产者 bug——显式抛错回滚整批（宁可红不可错），
        // 绝不把 seqs[s]! 断言掩盖的 undefined 序列化成 null 血缘静默写库
        evs.forEach((e, idx) => {
          if (e.sourceSeqs && e.sourceSeqs.length > 0) {
            for (const s of e.sourceSeqs) {
              if (!Number.isInteger(s) || s < 0 || s >= seqs.length) {
                throw new Error(
                  `appendEventsResolveLineage：批内 sourceSeqs 索引非法（${s}，批大小 ${seqs.length}）——事件 ${idx}「${e.type}」血缘引用越界`,
                )
              }
            }
            const resolved = e.sourceSeqs.map((s) => seqs[s]!)
            upd.run(JSON.stringify(resolved), sessionId, seqs[idx]!)
          }
        })
        touch.run(now, sessionId)
        db.exec('COMMIT')
        return seqs
      } catch (err) {
        db.exec('ROLLBACK')
        throw err
      }
    },
    appendEvent(sessionId: string, ev: NewEvent): number {
      return this.appendEvents(sessionId, [ev])[0]!
    },
    listEvents(book: string, sessionId?: string): ChatEvent[] {
      if (sessionId) {
        const rows = db.prepare('SELECT * FROM events WHERE session_id = ? ORDER BY seq ASC').all(sessionId) as unknown as Row[]
        return rows.map(rowToEvent)
      }
      const rows = db.prepare(
        `SELECT * FROM events
         WHERE session_id IN (SELECT session_id FROM sessions WHERE book = ?)
         ORDER BY seq ASC`
      ).all(book) as unknown as Row[];
      return rows.map(rowToEvent)
    },
    workspaceSession(book: string): string {
      const row = db.prepare(
        `SELECT session_id FROM sessions WHERE book = ? AND session_id LIKE 'ws-%' LIMIT 1`
      ).get(book) as { session_id: string } | undefined
      if (row) return row.session_id
      const sid = `ws-${ulid()}`
      const now = Date.now()
      db.prepare(
        `INSERT INTO sessions (session_id, format_version, book, header, created_at, updated_at)
         VALUES (?, 1, ?, ?, ?, ?)`
      ).run(sid, book, JSON.stringify({ kind: 'workspace' }), now, now)
      return sid
    },
    latestSession(book: string): SessionRow | null {
      // P2：排除 workspace 会话（ws- 前缀）——链路事件不干扰对话恢复选会话
      // P3-9：ORDER BY 加 rowid tiebreaker——同一毫秒创建/更新的多个会话选择结果稳定
      //（此前仅 updated_at DESC，同毫秒无次序锚，恢复选择不确定）
      const stmt = db.prepare(
        `SELECT * FROM sessions WHERE book = ? AND session_id NOT LIKE 'ws-%' ORDER BY updated_at DESC, rowid DESC LIMIT 1`
      );
      const r = stmt.get(book) as SessionRow | undefined
      return r ?? null
    },
    lastSeq(): number {
      const row = db.prepare('SELECT MAX(seq) AS m FROM events').get() as { m: number | null }
      return row.m ?? 0
    },
    clearBook(book: string): void {
      // RB-IF-P2-1：两条 DELETE 同事务（对齐同文件其他写路径）——中途失败/崩溃
      // 不留「events 已删、sessions 残留」的孤儿（孤儿 events 永久查不到，审计丢失）
      db.exec('BEGIN')
      try {
        db.prepare(
          `DELETE FROM events WHERE session_id IN (SELECT session_id FROM sessions WHERE book = ?)`
        ).run(book);
        db.prepare('DELETE FROM sessions WHERE book = ?').run(book)
        db.exec('COMMIT')
      } catch (err) {
        db.exec('ROLLBACK')
        throw err
      }
    },
    close(): void {
      // Y-P1-1/Y-P2-6：引用计数释放——归零才真关库 + 清缓存（幂等；旧引用后关不伤新开）
      if (entry.closed) return
      entry.refs--
      if (entry.refs <= 0) {
        entry.closed = true
        openStores.delete(dbPath)
        db.close()
      }
    },
  }
  entry.store = store
  openStores.set(dbPath, entry)
  return store
}

/**
 * 改书（书名/目录路径变更）时迁移事件库：<hash(oldRoot)>.db → <hash(newRoot)>.db，
 * 并把会话 book 字段改名——对话会话 book=oldName → newName，工作区会话
 * book=bookHash(oldRoot) → bookHash(newRoot)（对齐 clearChatHistory 的双钥匙口径）。
 *
 * 尽力而为：任一步失败只记日志不抛——数据留在旧库（孤儿但可找回），绝不删。
 * 前置：调用方须先中止该书在途对话/自愈（释放引用后再强制关库，避免打断写入）。
 */
export function migrateBookSession(
  userDataPath: string | null | undefined,
  oldRoot: string,
  newRoot: string,
  oldName: string,
  newName: string,
): void {
  if (!userDataPath) return
  const dir = join(userDataPath, 'clwriting', 'session')
  const oldDb = join(dir, bookHash(oldRoot) + '.db')
  const newDb = join(dir, bookHash(newRoot) + '.db')
  if (oldDb === newDb) return
  try {
    if (!existsSync(oldDb)) return
    // 1) 强制关掉旧库缓存连接（置 refs=0 → close 归零即真关+清缓存）
    const entry = openStores.get(oldDb)
    if (entry && !entry.closed) {
      entry.refs = 0
      entry.store.close()
    }
    // 2) 移动主库 + WAL/SHM 侧车（已 checkpoint 的库可能只有主库）
    for (const suffix of ['', '-wal', '-shm'] as const) {
      const from = oldDb + suffix
      const to = newDb + suffix
      if (existsSync(from)) renameSync(from, to)
    }
    // 3) 在新库上改会话 book 字段（对话 + 工作区两把钥匙）
    const db = new DatabaseSync(newDb)
    try {
      db.prepare('UPDATE sessions SET book = ? WHERE book = ?').run(newName, oldName)
      db.prepare('UPDATE sessions SET book = ? WHERE book = ?').run(bookHash(newRoot), bookHash(oldRoot))
    } finally {
      db.close()
    }
  } catch (e) {
    console.error('[events] 事件库迁移失败（旧库数据保留可找回）:', e)
  }
}

