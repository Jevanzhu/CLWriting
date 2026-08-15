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
import { mkdirSync } from 'node:fs'
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
  appendEvents(sessionId: string, events: NewEvent[]): number
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

/** 启动修复：孤儿 session（有 session/start 无 session/end）补 closers。
 *  Y-P1-1：跳过本进程活跃会话（SessionRecorder 登记中）——修复只面向崩溃残留，
 *  不得给进行中的会话插 session/end（否则审计流出现虚假中断）。 */
function repairOrphanSessions(db: DatabaseSync, skip: ReadonlySet<string>): void {
  const stmt = db.prepare(
    `SELECT e.session_id,
            SUM(CASE WHEN e.type = 'session/start' THEN 1 ELSE 0 END) AS starts,
            SUM(CASE WHEN e.type = 'session/end' THEN 1 ELSE 0 END) AS ends
     FROM events e
     WHERE e.session_id IN (SELECT DISTINCT session_id FROM events WHERE type = 'session/start')
     GROUP BY e.session_id`
  );
  const orphans = stmt.all() as Array<{ session_id: string; starts: number; ends: number }>
  const ins = db.prepare(
    `INSERT INTO events (session_id, type, data, replace_generation, created_at)
     VALUES (?, 'session/end', ?, 0, ?)`
  );
  const now = Date.now()
  for (const o of orphans) {
    if (o.starts > o.ends && !skip.has(o.session_id)) {
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
    appendEvents(sessionId: string, evs: NewEvent[]): number {
      const now = Date.now()
      const ins = db.prepare(
        `INSERT INTO events (session_id, turn, step, type, data, surface_op, shadow_start, shadow_end, source_seqs, replace_generation, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`
      );
      const touch = db.prepare('UPDATE sessions SET updated_at = ? WHERE session_id = ?')
      // P3-9：sessions.updated_at 挪进主事务——此前在 COMMIT 之后单独 UPDATE，若失败会
      // 误报「写失败」且客户端重试产生重复事件；现在与事件落库同事务，要么都成功要么都回滚。
      db.exec('BEGIN')
      try {
        for (const e of evs) {
          ins.run(sessionId, e.turn ?? null, e.step ?? null, e.type, JSON.stringify(e.data),
            e.surfaceOp ?? null, e.shadowStart ?? null, e.shadowEnd ?? null,
            e.sourceSeqs ? JSON.stringify(e.sourceSeqs) : null, now)
        }
        touch.run(now, sessionId)
        db.exec('COMMIT')
      } catch (err) {
        db.exec('ROLLBACK')
        throw err
      }
      return evs.length
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
        // 血缘回写：批内序号（0-based 同批前驱引用）→ 真实全局 seq，与插入同事务
        evs.forEach((e, idx) => {
          if (e.sourceSeqs && e.sourceSeqs.length > 0) {
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
      return this.appendEvents(sessionId, [ev])
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
      db.prepare(
        `DELETE FROM events WHERE session_id IN (SELECT session_id FROM sessions WHERE book = ?)`
      ).run(book);
      db.prepare('DELETE FROM sessions WHERE book = ?').run(book)
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

