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
import { join, resolve } from 'node:path'
import { ulid } from '../document/stable-id.js'
import type { ChatEvent, EventType, SurfaceOp } from './types.js'
import { log } from '../log/index.js'

/** 书 hash：sha256(bookRoot) 前 16 hex——稳定，不落原文路径。
 *  B-18（第六十轮补修）：哈希前 resolve 归一化——尾分隔符 / '.'/'..' 段变体不再
 *  同书分裂两库（原先 sha256 原样入参，路径形态敏感）。存量安全：调用点路径源于
 *  books.json 单源的绝对无尾斜杠形态，resolve 对其恒等 → 存量库键不变、无孤儿化；
 *  大小写不做归一（Linux 大小写敏感文件系统上大小写变体是不同路径，且收编会
 *  重键存量 macOS 库）。 */
export function bookHash(bookRoot: string): string {
  return createHash('sha256').update(resolve(bookRoot)).digest('hex').slice(0, 16)
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
  /** O-2（第十三轮）：可选 limit 限量通道（seq 升序取前 N）——现有调用方均为全量投影
   *  （折叠需要完整事件流，限流会破坏投影正确性，故不默认启用）；分页/审计渐进读取用。 */
  listEvents(book: string, sessionId?: string, limit?: number, type?: EventType): ChatEvent[]
  /** P2：每书一个 workspace 会话（ws- 前缀）承载非对话链路事件（step/llm/retry/check）；惰性创建复用 */
  workspaceSession(book: string): string
  latestSession(book: string): SessionRow | null
  /** 当前库最大 seq（recorder 算写入区间用） */
  lastSeq(): number
  clearBook(book: string): void
  /** 多 book 键单事务清理（第六轮低级项）：全清或全不动 */
  clearBooks(books: string[]): void
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
 *  加宽限期，按会话最后事件的 created_at 判断；距今不足阈值/拿不到时间 → 保守不补。
 *  P3：单会话修复失败不再 throw 中断循环——catch 收集错误继续修其余孤儿（一个会话
 *  的磁盘/库故障不该让全部崩溃残留永远补不上 end）；结尾汇总：部分失败 logger.warn
 *  聚合（自愈类故障按本文件 warn 风格留诊断），全部失败才上抛（系统性故障让打开方
 *  感知，与旧 throw 语义兼容）。导出供回归测试直接驱动。 */
export function repairOrphanSessions(db: DatabaseSync, skip: ReadonlySet<string>): void {
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
  // O-7（第十三轮）：补 end 后同步 touch sessions.updated_at——否则孤儿会话仍以旧
  // updated_at 被 latestSession 选中恢复（补了 end 却还被视为最新活跃会话）。
  // R64-9（十二轮）：touch 与补 end 解耦——touch 用会话真实 last_at 而非修复时刻：
  // 另一进程挂机超宽限的活跃会话被补 end 后，touch=now 会把「修复时刻」冒充「最后
  // 活动时刻」（审计流时序矛盾 + 恢复排序失真）；last_at 让 updated_at 始终反映
  // 真实活动，该会话后续真实写入自会再刷。
  const touch = db.prepare('UPDATE sessions SET updated_at = ? WHERE session_id = ?')
  const now = Date.now()
  let attempted = 0
  const errors: Array<{ session_id: string; err: unknown }> = []
  for (const o of orphans) {
    if (o.starts > o.ends && !skip.has(o.session_id)) {
      // 新近活跃（可能是另一进程进行中的会话）或时间不可得 → 不补虚假 end
      if (o.last_at === null || now - o.last_at < ORPHAN_GRACE_MS) continue
      attempted++
      // N-5（第五十四轮）：INSERT（补 end）与 UPDATE（touch updated_at）两步同事务——
      // 此前裸跑两语句，中途失败留「补了 end 但 updated_at 未刷」半态。同
      // migrateBookSession 的 BEGIN/COMMIT + 失败回滚用法；事务内单会话两语句，
      // 失败回滚不影响已成功补齐的其他孤儿。
      db.exec('BEGIN')
      try {
        ins.run(o.session_id, JSON.stringify({ reason: 'interrupted' }), now)
        touch.run(o.last_at, o.session_id) // R64-9：真实 last_at（上方头注）
        db.exec('COMMIT')
      } catch (err) {
        // R61-10（第六十一轮）：C4 同款加固——裸 ROLLBACK 在事务已自动回亡时抛
        // "no transaction is active"，会冲出本循环使本轮其余孤儿不被修复
        try {
          db.exec('ROLLBACK')
        } catch {
          /* 已自动回亡 */
        }
        // P3：收集后继续修其余孤儿——单会话故障不中断整轮修复
        errors.push({ session_id: o.session_id, err })
      }
    }
  }
  if (errors.length > 0) {
    const summary = errors.map((e) => `${e.session_id}: ${e.err instanceof Error ? e.err.message : String(e.err)}`).join('；')
    if (attempted > 0 && errors.length === attempted) {
      // 全部失败 = 系统性故障（库损坏/磁盘满）——上抛让打开方感知（旧语义）
      throw errors[0]!.err
    }
    log.warn('repair-orphan-sessions', `孤儿会话修复 ${errors.length}/${attempted} 个失败（其余已补齐）：${summary}`)
  }
}

// ── Y-P1-1/Y-P2-6：进程内连接单例（引用计数）+ 活跃会话登记 ──
// 此前每次 openSessionStore 都重跑 mkdir+PRAGMA+DDL×2+全表修复聚合（一次自愈写章
// 十次级连接开关），且修复会在活跃会话进行中注入虚假 session/end。现按 dbPath
// 缓存连接：缓存命中只计引用；close() 为「释放引用」，归零才真关库+清缓存。
// DDL 只在首次打开（或归零重开后）执行一次；孤儿修复除打开时一次外，写路径按
// TTL 惰性重跑（见 maybeRepairOrphans）——打开时仍在宽限期内的崩溃残留，长跑
// 进程不重开库也能在宽限期过后被补上 end。
interface StoreEntry {
  store: SessionStore
  refs: number
  closed: boolean
  lastOrphanRepairAt: number
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
  // 内存闸（2026-08-24 审计 B3）：打开期（PRAGMA/DDL/孤儿修复）抛错时句柄不滞留——
  // 此刻尚未登记 openStores，引用计数的 close 回收路径接不到它；调用方 catch 后降级
  // null 继续跑，句柄滞留进程积累（「损坏库重试」类测试反复触发尤甚）
  try {
    // N3（五十九轮）补：busy_timeout 必须先于 journal_mode=WAL 设置——WAL 切换在
    // journal_mode 处需拿写锁，若另一进程正持锁而 busy_timeout 未设，会立即抛
    // SQLITE_BUSY（N3 三进程并发首开回归在全量并发下偶发红的根因）
    db.exec('PRAGMA busy_timeout = 5000')
    // N3（五十九轮）：WAL 切换需短暂独占——并发首开下其他进程持锁（DDL/首写）时，
    // 即使 busy_timeout 也可能立即 SQLITE_BUSY 且库仍处 delete 态（幂等 no-op 兜底
    // 不够）。带退避重试：对方事务必然短（建表/一次 INSERT），数百 ms 内可得手。
    {
      let lastErr: unknown
      for (let i = 0; i < 8; i++) {
        try {
          db.exec('PRAGMA journal_mode = WAL')
          lastErr = null
          break
        } catch (err) {
          lastErr = err
          const mode = (db.prepare('PRAGMA journal_mode').get() as { journal_mode?: string } | undefined)?.journal_mode
          if (mode === 'wal') {
            lastErr = null
            break
          }
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50 * (i + 1))
        }
      }
      if (lastErr !== null) throw lastErr
    }
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
        created_at   INTEGER NOT NULL,
        updated_at   INTEGER NOT NULL
      )`
    );

    repairOrphanSessions(db, activeChatSessions)
  } catch (e) {
    try {
      db.close()
    } catch {
      /* best-effort：close 自身失败不再遮蔽原始错误 */
    }
    throw e
  }

  const entry: StoreEntry = { store: null!, refs: 1, closed: false, lastOrphanRepairAt: Date.now() }
  /** 写路径惰性孤儿修复（TTL = ORPHAN_GRACE_MS，至多每 10 分钟一次）：打开时仍在
   *  宽限期内的崩溃残留，宽限期过后随下一次会话写入补 end——无需等进程重开库。 */
  const maybeRepairOrphans = (): void => {
    if (Date.now() - entry.lastOrphanRepairAt < ORPHAN_GRACE_MS) return
    entry.lastOrphanRepairAt = Date.now()
    repairOrphanSessions(db, activeChatSessions)
  }
  const store: SessionStore = {
    dbPath,
    createSession(book: string, header?: Record<string, unknown>): string {
      maybeRepairOrphans()
      const sid = ulid()
      const now = Date.now()
      db.prepare(
        `INSERT INTO sessions (session_id, format_version, book, header, created_at, updated_at)
         VALUES (?, 1, ?, ?, ?, ?)`
      ).run(sid, book, JSON.stringify(header ?? {}), now, now)
      return sid
    },
    appendEvents(sessionId: string, evs: NewEvent[]): number[] {
      maybeRepairOrphans()
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
        // R61-10（第六十一轮）：C4 同款加固（见 cache/rebuild.ts）——SQLite 部分
        // 错误（如 SQLITE_FULL/IOERR）会自动回亡事务，再 ROLLBACK 抛
        // "no transaction is active" 掩蔽原始写错误；吞 ROLLBACK 自身异常、原样上抛
        try {
          db.exec('ROLLBACK')
        } catch {
          /* 已自动回亡 */
        }
        throw err
      }
    },
    // AA-P3-7：INSERT RETURNING 取真实 seq，sourceSeqs 批内索引同事务回写解析——
    // 血缘不再依赖 lastSeq()+批内序号推算（多窗口并发写事件库时可能错链到别窗的 seq）
    appendEventsResolveLineage(sessionId: string, evs: NewEvent[]): number[] {
      maybeRepairOrphans()
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
        // R61-10（第六十一轮）：C4 同款加固（见 cache/rebuild.ts）——SQLite 部分
        // 错误（如 SQLITE_FULL/IOERR）会自动回亡事务，再 ROLLBACK 抛
        // "no transaction is active" 掩蔽原始写错误；吞 ROLLBACK 自身异常、原样上抛
        try {
          db.exec('ROLLBACK')
        } catch {
          /* 已自动回亡 */
        }
        throw err
      }
    },
    appendEvent(sessionId: string, ev: NewEvent): number {
      return this.appendEvents(sessionId, [ev])[0]!
    },
    listEvents(book: string, sessionId?: string, limit?: number, type?: EventType): ChatEvent[] {
      // O-2（第十三轮）：limit 可选限量（seq 升序前 N）；投影折叠调用方不传（全量语义不变）
      const cap = typeof limit === 'number' && Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : undefined
      // 内存闸（2026-08-24 审计 B1）双降：①type 可选 SQL 下推——trace/cost 聚合只取
      // llm/call 小字段行，不再把全部对话正文一起载入解析；②游标 iterate 逐行 parse
      // ——原 stmt.all() 先物化全部行（data JSON 串一份）再 map JSON.parse 出第二份，
      // 双份共存峰值 ≈2× 表字节，与 rag readAllChunks 同修法
      const out: ChatEvent[] = []
      if (sessionId) {
        const args: Array<string | number> = [sessionId]
        if (type !== undefined) args.push(type)
        if (cap !== undefined) args.push(cap)
        const rows = db.prepare(
          `SELECT * FROM events WHERE session_id = ? ${type !== undefined ? 'AND type = ?' : ''} ORDER BY seq ASC ${cap !== undefined ? 'LIMIT ?' : ''}`
        ).iterate(...args) as unknown as Iterable<Row>
        for (const r of rows) out.push(rowToEvent(r))
        return out
      }
      const args: Array<string | number> = [book]
      if (type !== undefined) args.push(type)
      if (cap !== undefined) args.push(cap)
      const rows = db.prepare(
        `SELECT * FROM events
         WHERE session_id IN (SELECT session_id FROM sessions WHERE book = ?) ${type !== undefined ? 'AND type = ?' : ''}
         ORDER BY seq ASC ${cap !== undefined ? 'LIMIT ?' : ''}`
      ).iterate(...args) as unknown as Iterable<Row>
      for (const r of rows) out.push(rowToEvent(r))
      return out
    },
    workspaceSession(book: string): string {
      // N3（五十九轮）：SELECT→INSERT 包 BEGIN IMMEDIATE——双进程并行首开同书时，原裸
      // SELECT→INSERT 竞态会分裂两个 ws 会话（链路事件分裂写入两处）。IMMEDIATE 拿写锁
      // 后 SELECT→INSERT 原子化：后到进程的 BEGIN IMMEDIATE 在 busy_timeout 内等待，
      // 拿锁后重查必见先到者已 INSERT 的行 → 复用同一 ws 会话。
      // 未加 (book, ws-) 唯一约束：sessions 表既有库可能已有历史重复 ws 行（先查重再建
      // 索引会破坏「不动既有库」边界），事务串行化已闭合分裂窗口。
      db.exec('BEGIN IMMEDIATE')
      try {
        const row = db.prepare(
          `SELECT session_id FROM sessions WHERE book = ? AND session_id LIKE 'ws-%' LIMIT 1`
        ).get(book) as { session_id: string } | undefined
        if (row) {
          db.exec('COMMIT')
          return row.session_id
        }
        const sid = `ws-${ulid()}`
        const now = Date.now()
        db.prepare(
          `INSERT INTO sessions (session_id, format_version, book, header, created_at, updated_at)
           VALUES (?, 1, ?, ?, ?, ?)`
        ).run(sid, book, JSON.stringify({ kind: 'workspace' }), now, now)
        db.exec('COMMIT')
        return sid
      } catch (err) {
        // R61-10（第六十一轮）：C4 同款加固（见 cache/rebuild.ts）——SQLite 部分
        // 错误（如 SQLITE_FULL/IOERR）会自动回亡事务，再 ROLLBACK 抛
        // "no transaction is active" 掩蔽原始写错误；吞 ROLLBACK 自身异常、原样上抛
        try {
          db.exec('ROLLBACK')
        } catch {
          /* 已自动回亡 */
        }
        throw err
      }
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
        // R61-10（第六十一轮）：C4 同款加固（见 cache/rebuild.ts）——SQLite 部分
        // 错误（如 SQLITE_FULL/IOERR）会自动回亡事务，再 ROLLBACK 抛
        // "no transaction is active" 掩蔽原始写错误；吞 ROLLBACK 自身异常、原样上抛
        try {
          db.exec('ROLLBACK')
        } catch {
          /* 已自动回亡 */
        }
        throw err
      }
    },
    clearBooks(books: string[]): void {
      // 低级项（第六轮）：多 book 键单事务清理——audit DELETE / chat 清史都是
      // bookName + bookHash 双钥匙，两次 clearBook 各自事务：第二键失败时第一键已提交，
      // 两侧一半清一半留。单 BEGIN 内循环两键的 DELETE，要么全清要么全不动
      db.exec('BEGIN')
      try {
        for (const book of books) {
          db.prepare(
            `DELETE FROM events WHERE session_id IN (SELECT session_id FROM sessions WHERE book = ?)`
          ).run(book);
          db.prepare('DELETE FROM sessions WHERE book = ?').run(book)
        }
        db.exec('COMMIT')
      } catch (err) {
        // R61-10（第六十一轮）：C4 同款加固（见 cache/rebuild.ts）——SQLite 部分
        // 错误（如 SQLITE_FULL/IOERR）会自动回亡事务，再 ROLLBACK 抛
        // "no transaction is active" 掩蔽原始写错误；吞 ROLLBACK 自身异常、原样上抛
        try {
          db.exec('ROLLBACK')
        } catch {
          /* 已自动回亡 */
        }
        throw err
      }
    },
    close(): void {
      // Y-P1-1/Y-P2-6：引用计数释放——归零才真关库 + 清缓存（幂等；旧引用后关不伤新开）。
      // 第九轮 L-5：refs 已归零再 close 直接忽略——防重复 close 把计数推负导致
      // 后续 open 复用「负引用」条目（调用方纪律仍是一开一闭）
      if (entry.closed || entry.refs <= 0) return
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
 * 返回布尔（5.1-3）：true = 成功，或无需迁移的 no-op（无 userDataPath / 新旧同路径 /
 * 旧库不存在——没有数据要搬，对调用方不构成失败）；false = 迁移尝试失败，源库
 * 原地完整可用（可安全重试）。失败不再只有 console.error 一个出口——调用方
 * （books.ts 改名端点）把 false 传进响应让用户感知，不再静默吞掉。
 *
 * 5.1-3（WAL 窗口修复）失败路径纪律：
 * - 搬移前先对源库 wal_checkpoint(TRUNCATE)，把未落盘事务折进主库文件——此前先搬
 *   主库再搬 WAL/SHM 侧车，侧车搬移失败时未 checkpoint 的事务随 WAL 一起丢失；
 * - checkpoint 忙（busy=1：另有连接持读/写/EXCLUSIVE 锁，busy_timeout 5000ms 内
 *   等不到）或搬移/改钥匙任一步失败 → 整体放弃：已搬文件逆序搬回源位，绝不留
 *   「主库已走、侧车滞留」的半搬状态。
 * 前置：调用方须先中止该书在途对话/自愈（释放引用后再强制关库，避免打断写入）。
 */
export function migrateBookSession(
  userDataPath: string | null | undefined,
  oldRoot: string,
  newRoot: string,
  oldName: string,
  newName: string,
): boolean {
  if (!userDataPath) return true
  const dir = join(userDataPath, 'clwriting', 'session')
  const oldDb = join(dir, bookHash(oldRoot) + '.db')
  const newDb = join(dir, bookHash(newRoot) + '.db')
  if (oldDb === newDb) return true
  // 已完成搬移的记录（from=源位 to=新位）：任一步失败时逆序搬回，保证源库原地完整
  const moves: Array<{ from: string; to: string }> = []
  try {
    if (!existsSync(oldDb)) return true
    // 1) 强制关掉旧库缓存连接（置 refs=1 → close 递减归零即真关+清缓存）。
    //    必须先于 checkpoint：自家连接不关，其 WAL 归属/折叠时机不受本函数控制。
    //    第十轮 M-1：不能置 refs=0——第九轮 L-5 守卫把「refs<=0 再 close」当
    //    重复释放直接忽略，强制关会静默落空（僵尸条目滞留缓存，旧路径重开
    //    拿到别名已迁走库的句柄，写入分裂到旧路径 -wal）；置 1 走正常递减路径，
    //    真关语义不变
    //    N8（五十九轮）：强制关库前断言无在途引用——「先中止会话」此前只是头注里的
    //    调用方纪律，无程序性保障；refs>0 = 仍有 openSessionStore 未 close 的使用方
    //    （在途对话/自愈/链路记录），此刻强关会把它们的后续写入打到已关句柄上。给
    //    可读错误并放弃迁移（false，源库原地完整可重试），让调用方先收口再迁。
    //    R64-8（十二轮）：判定从 refs>1 收紧为 refs>0——refs==1（首个在途调用方）
    //    同样是活跃持有者，此前会被当「无引用」强关，且错误文案少算一个。
    const entry = openStores.get(oldDb)
    if (entry && !entry.closed) {
      if (entry.refs > 0) {
        log.error(
          'events',
          `事件库迁移中止：旧库仍有 ${entry.refs} 个在途引用（${oldDb}）——请先中止该书在途对话/自愈并释放连接后重试`,
        )
        return false
      }
      entry.refs = 1
      entry.store.close()
    }
    // 2) 5.1-3：搬移前折叠 WAL——TRUNCATE 模式把未 checkpoint 事务折进主库并截断
    //    -wal，此后即使只搬走主库文件数据也完整。busy_timeout 与库打开纪律一致
    //    （5000ms）：给短暂并发的写方留收尾时间；等不到（另有连接持锁）返回
    //    busy=1 → 整体放弃，此时一个文件都还没动，源库原地完整
    const cp = new DatabaseSync(oldDb)
    try {
      cp.exec('PRAGMA busy_timeout = 5000')
      const r = cp.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get() as { busy: number } | undefined
      if (!r || r.busy !== 0) {
        log.error('events', `事件库迁移前 checkpoint 忙（busy=${r?.busy ?? '未知'}），放弃迁移，源库原地保留`)
        return false
      }
    } finally {
      cp.close()
    }
    // 3) 移动主库 + 残留侧车（TRUNCATE checkpoint + 连接全关后通常只剩主库文件；
    //    有竞态残留时一并搬走）。任一 rename 失败 → 外层 catch 逆序回滚已搬文件。
    //    kk-P2-3：目标位已有同名库/侧车 → 放弃迁移（false）——renameSync 在 POSIX 上
    //    静默覆盖，会把目标位既有数据毁掉（hash 碰撞或旧书残库场景）；源库原地保留
    //    供人工裁决，绝无声默覆盖
    for (const suffix of ['', '-wal', '-shm'] as const) {
      if (existsSync(newDb + suffix)) {
        log.error('events', `事件库迁移目标已存在（${newDb + suffix}），放弃迁移避免覆盖，源库原地保留`)
        return false
      }
    }
    for (const suffix of ['', '-wal', '-shm'] as const) {
      const from = oldDb + suffix
      const to = newDb + suffix
      if (existsSync(from)) {
        renameSync(from, to)
        moves.push({ from, to })
      }
    }
    // 4) 在新库上改会话 book 字段（对话 + 工作区两把钥匙）。两条 UPDATE 同事务：
    //    中途失败随连接关闭整体回滚，不留「一把钥匙已改、一把没改」的半改状态；
    //    随后外层把文件搬移一并回滚——否则库在新位而钥匙是旧名，新旧两头都查不到。
    //    kk-P2-4：busy_timeout 先于 BEGIN——同进程连接已全关，但另一进程（第二个
    //    studio 实例）若恰在此窗口打开新库，裸 BEGIN 会立刻 SQLITE_BUSY 而非等待
    const db = new DatabaseSync(newDb)
    try {
      db.exec('PRAGMA busy_timeout = 5000')
      db.exec('BEGIN')
      db.prepare('UPDATE sessions SET book = ? WHERE book = ?').run(newName, oldName)
      db.prepare('UPDATE sessions SET book = ? WHERE book = ?').run(bookHash(newRoot), bookHash(oldRoot))
      db.exec('COMMIT')
    } finally {
      // 未 COMMIT 的事务随连接关闭回滚（先关干净再让异常冒泡去回滚文件搬移）
      db.close()
    }
    return true
  } catch (e) {
    // 整体放弃：逆序把已搬文件搬回源位——源库原地完整、可读、可重试
    for (let i = moves.length - 1; i >= 0; i--) {
      const m = moves[i]!
      try {
        renameSync(m.to, m.from)
      } catch (e2) {
        // 回滚单文件失败属 OS 级异常（权限/磁盘满）：如实记日志供人工找回，
        // 不在回滚路径里再抛新异常掩盖原始失败原因
        log.error('events', `迁移回滚失败（${m.to} → ${m.from}），需人工找回`, e2)
      }
    }
    log.error('events', '事件库迁移失败（已回滚，源库原地完整可找回）', e)
    return false
  }
}

