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
  appendEvent(sessionId: string, ev: NewEvent): number
  listEvents(book: string, sessionId?: string): ChatEvent[]
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

/** 启动修复：孤儿 session（有 session/start 无 session/end）补 closers */
function repairOrphanSessions(db: DatabaseSync): void {
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
    if (o.starts > o.ends) ins.run(o.session_id, JSON.stringify({ reason: 'interrupted' }), now)
  }
}

/**
 * 打开本书事件库（userDataPath 为空 → null，调用方退化内存模式）。
 * 建目录 + DDL + 启动修复，同步返回。
 */
export function openSessionStore(userDataPath: string | null | undefined, bookRoot: string): SessionStore | null {
  if (!userDataPath) return null
  const dir = join(userDataPath, 'clwriting', 'session')
  mkdirSync(dir, { recursive: true })
  const dbPath = join(dir, bookHash(bookRoot) + '.db')
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

  repairOrphanSessions(db)

  return {
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
      db.exec('BEGIN')
      try {
        for (const e of evs) {
          ins.run(sessionId, e.turn ?? null, e.step ?? null, e.type, JSON.stringify(e.data),
            e.surfaceOp ?? null, e.shadowStart ?? null, e.shadowEnd ?? null,
            e.sourceSeqs ? JSON.stringify(e.sourceSeqs) : null, now)
        }
        db.exec('COMMIT')
      } catch (err) {
        db.exec('ROLLBACK')
        throw err
      }
      db.prepare('UPDATE sessions SET updated_at = ? WHERE session_id = ?').run(now, sessionId)
      return evs.length
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
    latestSession(book: string): SessionRow | null {
      const stmt = db.prepare(
        `SELECT * FROM sessions WHERE book = ? ORDER BY updated_at DESC LIMIT 1`
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
      db.close()
    },
  }
}

