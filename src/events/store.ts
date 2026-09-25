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
 *
 * 拆分沿革（R0916-5g，2026-09-16 ⑤④产品巨件拆分波3）：本单件（1355 行）三缝
 * 纯移动拆分——跨进程开口标记 + 迁移墓碑族 → store-open-markers.ts（缝 A）；
 * 行读取族（SessionRow/Row/rowToEvent/safeRowToEvent）→ store-rows.ts（缝 B）；
 * 书 hash 定位族 + 迁移锁族 → store-migrate.ts（缝 C）。本残核保留：开库门面
 * （openSessionStore/Async、SessionStore/NewEvent）、R46-42 prepared 语句缓存族
 * （closeEventsDb 函数本体被 test/events/r0911-g-p3-4-close-cache.test.ts 结构
 * 契约钉在本文件源文本）、孤儿修复、连接单例族、开口标记续期 let 与其注入
 * setter（R26-105 禁 export let，唯一读点在 firstOpenStore 故留残核）、
 * migrateBookSession（其墓碑预写调用点被 test/events/r41-tombstone-intact.test.ts
 * 写侧静态扫描钉在本文件源文本，且消费 openStores/closeEventsDb，移出必造环回引）
 * 与 firstOpenStore（巨型对象字面量——重设计立案件，登记台账 §三 E 域，本批
 * 零触碰）。迁出公开名 bookHash/sessionMigrateLockPath/getSessionMigrateLockTimeoutMs/
 * __setSessionMigrateLockTimeoutForTest 与类型 SessionRow 经下方逐名 re-export 桥
 * 接，全库消费方 import 面零改动。运行时依赖单向：本文件 → store-open-markers/
 * store-rows/store-migrate，三新文件均不回引本模块，无环。本头注上方原文全部
 * 历史记载原样保留。
 */
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync, existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
// R0916-nano-9（四轮处置批）：ulid 改直连 fs/id.ts 单源（events→document 跨层边消除；
// document/stable-id.js 的 re-export 垫片保留给 document 域既有调用方，勿再扩散）
import { ulid } from '../fs/id.js'
import type { ChatEvent, EventType } from './types.js'
import { SURFACE_EVENT_TYPES } from './types.js'
import { log, errMsg } from '../log/index.js'
import { acquireCrossProcessLockWithTimeout, acquireCrossProcessLockAsync } from '../fs/cross-process-lock.js'
import { renameWithRetry, atomicWriteFile } from '../fs/atomic.js'
import { safeRowToEvent, type Row, type SessionRow } from './store-rows.js'
import { MIGRATED_EXT, sweepOpenMarkers, registerOpenMarker, touchOpenMarker, releaseOpenMarker } from './store-open-markers.js'
import { bookHash, sessionMigrateLockPath, getSessionMigrateLockTimeoutMs, acquireMigrateLockPairAsync } from './store-migrate.js'
import { prepared, closeWithPrepared } from '../shared/sqlite-prepared.js'

// R0916-5g 桥：迁出缝的公开名逐名再导出（类型走 export type），消费方 import 面零改动
export { bookHash, sessionMigrateLockPath, getSessionMigrateLockTimeoutMs, __setSessionMigrateLockTimeoutForTest } from './store-migrate.js'
export type { SessionRow } from './store-rows.js'

// R26-20（二十六轮）：sourceSeqs 同名双语义拆分——NewEvent 额外提供 sourceIdxs
// （批内 0-based 索引，仅供 appendEventsResolveLineage 消费）；sourceSeqs 收窄为
// 「全局 seq」（appendEvents 原样落库路径，如 compaction/end 遮蔽区间）。两字段
// 不再共用一名，appendEventsResolveLineage 对 sourceSeqs 拒收（宁可红不可错）。
export type NewEvent = Omit<ChatEvent, 'seq' | 'sessionId' | 'createdAt' | 'replaceGeneration'> & {
  /** 批内 0-based 血缘索引（同批前驱引用）——仅供 appendEventsResolveLineage 消费：
   *  INSERT RETURNING 拿到真实 seq 后同事务回写解析为全局 seq 落 source_seqs 列。
   *  appendEvents（原样落库）不解析本字段，勿在此路径传。 */
  sourceIdxs?: number[]
}

export interface SessionStore {
  dbPath: string
  createSession(book: string, header?: Record<string, unknown>): string
  /** 落库一批事件，返回数据库真实分配的 seq 数组（与 events 一一对应）。
   *  RB-IF-P1-2：compaction 事件的 sourceSeqs 是全局 seq（遮蔽区间），不走
   *  appendEventsResolveLineage 的批内索引解析——由本方法原样落库并返回真实 seq。
   *  R26-20（二十六轮）：本路径的 sourceSeqs 语义即「全局 seq」（原样落库），已按
   *  类型注释收窄；批内索引血缘请走 appendEventsResolveLineage + sourceIdxs。 */
  appendEvents(sessionId: string, events: NewEvent[]): number[]
  /** AA-P3-7：落库并返回真实分配的 seq（INSERT RETURNING，单事务内回写血缘）。
   *  R26-20（二十六轮）：events 的批内血缘改由 sourceIdxs（0-based，同批前驱引用）
   *  传入——原与 appendEvents 的 sourceSeqs（全局 seq）同名双语义，调用方极易把
   *  全局 seq 传进本方法被当批内索引错链（或反之）；现按方法拆分并对 sourceSeqs
   *  拒收报错（文案说明陷阱）。返回 seq 数组与 events 一一对应。 */
  appendEventsResolveLineage(sessionId: string, events: NewEvent[]): number[]
  // B3（复审-0914-优化修复批）：appendEvent 单事件便捷封装随清理批删除（R66-13 原注
  // 即预告）——生产链全走批接口，测试消费方已随本批迁 appendEvents(sid,[ev])[0]!。
  /** O-2（第十三轮）：可选 limit 限量通道（seq 升序取前 N）——现有调用方均为全量投影
   *  （折叠需要完整事件流，限流会破坏投影正确性，故不默认启用）；分页/审计渐进读取用。 */
  listEvents(book: string, sessionId?: string, limit?: number, type?: EventType): ChatEvent[]
  /** R0910-W：流式读（无 limit，seq 升序）——逐行 yield 不物化，供分析读侧（llm/call
   *  成本/轨迹聚合）边读边聚合，避免把整段过滤集堆进数组；坏行降级与 listEvents 同
   *  （R65-20）。调用方负责 close；投影折叠等需要完整数组的调用方继续走 listEvents。 */
  iterateEvents(book: string, sessionId?: string, type?: EventType): IterableIterator<ChatEvent>
  // ── 0917清库修复批（台账「事件读链 O(N)」待拍板项转实施）：真尾窗三原语 ──
  // 消费者唯一 = chat-history 真尾窗（src/studio/server/api/chat-history.ts）；三件
  // 成套供给（尾取 / 骨架计数 / 安全边界），缺一即破坏窗口投影与全量投影的逐位
  // 等价论证，他处勿零散复制口径。
  /** seq 降序取尾 N 条、反转升序返回（坏行降级与 listEvents 同源 safeRowToEvent）。
   *  chat/history 真尾窗消费——前端种子只需尾部窗口，不再全量投影出网。 */
  listEventsTail(book: string, tail: number): ChatEvent[]
  /** 骨架计数通道：SQL COUNT 行数（含无法解析行，不 JSON.parse）。截断态 total 的
   *  O(1) 口径——全量投影消息数需全量 parse，截断态改记事件行数（契约注释见
   *  buildChatHistoryView）。 */
  countEvents(book: string): number
  /** 最早携带分支元数据（data 含 branchId/parentSeq 键）的事件 seq（无 → null）——
   *  尾窗安全边界：窗口起点 ≤ 本值 ⟺ 窗口内投影与全量投影逐位等价（顶替槽重建与
   *  默认分支判定所需的全部键载体都在窗内；parentSeq 指向窗外线性锚不受影响——
   *  槽区间按 seq 值判定，锚不必在窗内）。0918四轮修复批（B401）：键匹配由 LIKE 全表
   *  扫改走 has_branch_meta 生成列 + 部分索引 idx_events_branch_meta（见首开 DDL 注）：
   *  instr 与 LIKE 对实际数据逐位等价——键恒由 JSON.stringify 带引号精确大小写序列化
   *  （漏报不可能），正文巧含关键字的误报两形态同样命中，只令窗口多取不损正确性。 */
  firstBranchMetaSeq(book: string): number | null
  /** P2：每书一个 workspace 会话（ws- 前缀）承载非对话链路事件（step/llm/retry/check）；惰性创建复用 */
  workspaceSession(book: string): string
  /** R66-13（十四轮）：最新对话会话查询——生产零调用（对话恢复经内存 histories/restore
   *  路径，不查库选会话），仅 test/events/** 直测使用；其语义锚点（孤儿修复 touch
   *  updated_at 的排序口径）由测试守护，待清理批定夺去留。 */
  latestSession(book: string): SessionRow | null
  /** 当前库最大 seq（recorder 算写入区间用） */
  lastSeq(): number
  /** R66-16（十四轮）：SessionRecorder.close 写 compaction 前遮蔽区间自检的数据源
   *  （validateEventStream 生产接线的写点前置）。全局 seq 口径——遮蔽可指向跨会话
   *  恢复历史的旧 seq，不能按 session 过滤。返回：①与 [from,to] 相交的既有
   *  compaction/end 遮蔽区间；②该区间内的表面类候选事件行（type+data JSON 串，
   *  供调用侧按投影口径判「曾可见」）。 */
  maskSelfCheckData(from: number, to: number): {
    intervals: Array<{ start: number; end: number }>
    rows: Array<{ seq: number; type: string; data: string }>
  }
  clearBook(book: string): void
  /** 多 book 键单事务清理（第六轮低级项）：全清或全不动 */
  clearBooks(books: string[]): void
  close(): void
}

// ── R46-42（四十六轮）：连接级 prepared 语句缓存 ─────────────────────────
// node:sqlite 的 StatementSync 与连接实例绑定，但 db.prepare 每次调用都重新编译同一
// 条 SQL——热路径（appendEvents 每批 2 条、listEvents 每读、workspaceSession 每链路
// 事件写）此前对固定 SQL 反复 prepare，纯白付编译开销。按 db 实例（WeakMap 键）+
// SQL 串双键缓存编译产物：连接 close 后缓存条目随 GC 消失，无悬挂执行面（重开库是
// 新实例、新缓存，天然隔离）。低频迁移/一次性语句（DDL、孤儿修复、钥匙改写、PRAGMA）
// 不走本帮手——缓存面只进恒定不变的高频 SQL。listEvents 的可选 type/limit 拼出的
// SQL 变体以 SQL 串本身为键，各自独立缓存（变体数有界）。
// R0911-G-P3-4（2026-09-11 重评修复批）修账：原注「连接 close 后缓存条目随 GC 消失」
// 不成立——node:sqlite StatementSync 强引用 DatabaseSync，与 WeakMap 弱键构成
// ephemeron 环，实测 close 后条目不回收（每次开/关滞留 ~0.35KB；语句是否执行过无关，
// 入缓存即滞留）。事件库是每会话一开的长连接（引用计数制），泄漏量级远小于 RAG
//（每次召回两开两关的重灾区，另见 rag/store.ts closeRagDb），但根因同一——本文件
// db 的 close 一律走下方 closeEventsDb（先 preparedByDb.delete 再 close，断链后实测归零）。
// R0917-6-P3-7（2026-09-17 全库源码重评六轮修复批）：prepared 缓存与配对关库收编
// shared/sqlite-prepared.ts 单源——原三域各持一份逐字同构实现（R46-42 本文件 /
// R46-45 rag / 重评-0914 nano R3-3 check），R0911-G-P3-4 族根因已需分头各修一遍；
// 断链序与用法契约单点见单源文件头注。本文件 import 直用其 `prepared`（下方各调用点
// 名不变），close 侧只留 closeEventsDb 薄封装——原件「先 delete 再 close」的断链序
// 已移入单源，此处不再复述。
/** R0911-G-P3-4：带缓存注销的关库——本文件事件库句柄的 close 统一出口（勿裸 db.close）。
 *  根因与量级见上方 R46-42 注释块修账记；断链序单点在 shared/sqlite-prepared.ts。 */
function closeEventsDb(db: DatabaseSync): void {
  closeWithPrepared(db)
}

/** 孤儿会话补 end 的宽限期：最后活动距今不足该值视为「可能仍在进行」，不补（RB-IF-P2-2）。
 *  R65-19（十三轮）：宽限期对齐对话硬超时——AGENT_DEADLINE_MS = 30 分钟
 *  （src/ai/orchestrate/chat.ts，含嵌套 self-heal 的长对话最后活动后仍可能在跑），
 *  原 10 分钟会在对话进行中被跨进程误补 session/end {reason:'interrupted'}（审计流
 *  虚假中断 + 真实 session/end 后补双写）。取 32 分钟 = deadline + 2 分钟收尾余量；
 *  不 import 该常量（chat.ts 反向依赖本文件，提常量会成环），改由注释锚定对齐依据。 */
const ORPHAN_GRACE_MS = 32 * 60 * 1000

/** R0916-7-P3-11（1.0 前质量债批）：BEGIN / COMMIT / 失败回滚 事务样板单点——
 *  appendEvents、appendEventsResolveLineage、clearBook、clearBooks 四处逐字重复
 *  （原各写一份 catch 回滚块，改一处漏三处）。
 *  回滚语义不变：SQLite 部分错误（SQLITE_FULL/IOERR 等）会自动回亡事务，此时裸
 *  ROLLBACK 抛 "no transaction is active" 会掩蔽原始写错误（R61-10/C4 加固）——
 *  吞掉 ROLLBACK 自身异常、原样上抛业务错误。BEGIN 走默认（deferred）档，与
 *  四处原实现的 db.exec('BEGIN') 逐位一致；需 IMMEDIATE 写锁的调用点（workspaceSession
 *  的 SELECT→INSERT 串行化、迁移钥匙改写）语义不同，仍自持事务，不走本处。 */
function withEventsTx<T>(db: DatabaseSync, body: () => T): T {
  db.exec('BEGIN')
  try {
    const out = body()
    db.exec('COMMIT')
    return out
  } catch (err) {
    try {
      db.exec('ROLLBACK')
    } catch {
      /* 已自动回亡 */
    }
    throw err
  }
}

/** R71-24（十九轮）：开口标记续期周期——活句柄定期 utimes 刷标记 mtime，让「标记年龄」
 *  成为可靠的存活旁证（缺省 30s，测试可注入）。 */
let OPEN_MARKER_RENEW_MS = 30_000

/** 测试注入续期周期（生产勿调）。 */
export function configureOpenMarkerRenewMs(ms: number): void {
  OPEN_MARKER_RENEW_MS = ms
}

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
  // R33-37（三十三轮）：键集分批（500/批）——原单条聚合 SELECT 无 LIMIT，超大库每次
  // 惰性修复全表 GROUP BY；按 session_id 有序键集翻页，单批 IO 有界，修复语义不变。
  const BATCH_SIZE = 500
  const stmt = db.prepare(
    `SELECT e.session_id,
            SUM(CASE WHEN e.type = 'session/start' THEN 1 ELSE 0 END) AS starts,
            SUM(CASE WHEN e.type = 'session/end' THEN 1 ELSE 0 END) AS ends,
            MAX(e.created_at) AS last_at
     FROM events e
     WHERE e.session_id IN (SELECT DISTINCT session_id FROM events WHERE type = 'session/start')
       AND e.session_id > ?
     GROUP BY e.session_id
     ORDER BY e.session_id
     LIMIT ${BATCH_SIZE}`
  );
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
  // R67-6（十五轮）：事务内复核语句——外层 SELECT 与本事务之间，他进程可能已给同一
  // 孤儿补上 session/end（两进程并行修复同一批孤儿的 TOCTOU：双双见 starts>ends →
  // 双 INSERT → 事件流出现成对 interrupted end）。BEGIN IMMEDIATE 在 BEGIN 即取写锁
  // （互斥另一写方，busy_timeout 内排队），复核读到的是排他后的最新计数，仍
  // starts>ends 才补；否则本事务空提交（他进程已补，无需重复）。
  const recheck = db.prepare(
    `SELECT SUM(CASE WHEN type = 'session/start' THEN 1 ELSE 0 END) AS starts,
            SUM(CASE WHEN type = 'session/end' THEN 1 ELSE 0 END) AS ends
     FROM events WHERE session_id = ?`
  )
  const now = Date.now()
  let attempted = 0
  const errors: Array<{ session_id: string; err: unknown }> = []
  let lastSessionId = ''
  for (;;) {
    const orphans = stmt.all(lastSessionId) as Array<{ session_id: string; starts: number; ends: number; last_at: number | null }>
    if (orphans.length === 0) break
    lastSessionId = orphans[orphans.length - 1]!.session_id
    for (const o of orphans) {
      // nano-7（四轮处置批）：内层循环体缩进归位（原整块少一层，纯格式零行为）
      if (o.starts > o.ends && !skip.has(o.session_id)) {
        // 新近活跃（可能是另一进程进行中的会话）或时间不可得 → 不补虚假 end
        if (o.last_at === null || now - o.last_at < ORPHAN_GRACE_MS) continue
        attempted++
        // N-5（第五十四轮）：INSERT（补 end）与 UPDATE（touch updated_at）两步同事务——
        // 此前裸跑两语句，中途失败留「补了 end 但 updated_at 未刷」半态。同
        // migrateBookSession 的 BEGIN/COMMIT + 失败回滚用法；事务内单会话两语句，
        // 失败回滚不影响已成功补齐的其他孤儿。
        // R31-22（三十一轮）：BEGIN 挪进 try——BEGIN IMMEDIATE 在 busy_timeout 耗尽时
        // 抛错，此前会冲出本循环经 maybeRepairOrphans（挂 createSession 头部；R53-B-3
        // 起不再挂 appendEvents 热路径）让无关的正常写入直接抛错；挪入后按单会话错误
        // 收集继续。
        try {
          db.exec('BEGIN IMMEDIATE')
          const fresh = recheck.get(o.session_id) as { starts: number | null; ends: number | null } | undefined
          if (fresh && (fresh.starts ?? 0) > (fresh.ends ?? 0)) {
            ins.run(o.session_id, JSON.stringify({ reason: 'interrupted' }), now)
            touch.run(o.last_at, o.session_id) // R64-9：真实 last_at（上方头注）
          }
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
    if (orphans.length < BATCH_SIZE) break
  }
  if (errors.length > 0) {
    const summary = errors.map((e) => `${e.session_id}: ${e.err instanceof Error ? e.err.message : String(e.err)}`).join('；')
    if (attempted > 0 && errors.length === attempted) {
      // 全部失败 = 系统性故障（库损坏/磁盘满）——上抛让打开方感知（旧语义）。
      // R33-38（三十三轮）：聚合上抛——原只抛首个病因，N 个会话的 N 种病因被降级单条。
      throw new Error(`孤儿会话修复全部失败（${errors.length}/${attempted}）：${summary}`)
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
  /** R71-24：开口标记续期定时器（unref；真关库时清除） */
  markerTimer: ReturnType<typeof setInterval> | null
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
  // R66-12（十四轮）：首开段（建库 + DDL + 孤儿修复）进 session 跨进程锁——
  // 此前另一进程恰在迁移的 checkpoint 与 rename 之间首开旧库时，SQLite 会在旧路径
  // 重建空库（旧 hash 下对话历史「清零」）或对半搬文件集跑 DDL（撕裂态）；缓存命中
  // 复用无文件操作，不加锁。超时上抛 = 打开失败（调用方既有 catch 降级 null 语义）。
  // R73-38：锁按 bookHash 分书（见 sessionMigrateLockPath 注）——只与同书的首开/迁移互斥。
  // R34D-19（三十四轮）：本函数为**同步开库壳**——锁等待为同步原语（Atomics.wait 最坏
  // 5s），仅供 CLI/测试等合法同步面使用；服务进程事件循环上的调用必须改用
  // openSessionStoreAsync（等待期 setTimeout 轮询不阻塞事件循环，R30-3/R33D-1 纪律）。
  const releaseOpenLock = acquireCrossProcessLockWithTimeout(
    sessionMigrateLockPath(userDataPath, bookRoot),
    getSessionMigrateLockTimeoutMs(),
  )
  if (!releaseOpenLock) {
    throw new Error(`事件库打开锁获取超时（另一进程正在迁移会话库），本进程首开 ${dbPath} 失败——可重试`)
  }
  try {
    return firstOpenStore(bookRoot, dir, dbPath)
  } finally {
    releaseOpenLock()
  }
}

/** R34D-19（三十四轮）：openSessionStore 的异步孪生——首开锁等待走
 *  acquireCrossProcessLockAsync（setTimeout 轮询），服务进程事件循环不再被双进程
 *  争用窗内的 5s Atomics.wait 停住（chat/audit/check 等端点冷首开面）。语义与同步壳
 *  逐位对齐：缓存命中免锁直复用；锁等待窗内他任务完成首开 → 拿锁后**双检缓存**复用
 *  （引用计数与命中路径一致）；超时抛同文案错误（调用方既有 catch 降级 null 语义）。 */
export async function openSessionStoreAsync(
  userDataPath: string | null | undefined,
  bookRoot: string,
): Promise<SessionStore | null> {
  if (!userDataPath) return null
  const dir = join(userDataPath, 'clwriting', 'session')
  const dbPath = join(dir, bookHash(bookRoot) + '.db')
  const cached = openStores.get(dbPath)
  if (cached && !cached.closed) {
    cached.refs++
    return cached.store
  }
  const releaseOpenLock = await acquireCrossProcessLockAsync(
    sessionMigrateLockPath(userDataPath, bookRoot),
    getSessionMigrateLockTimeoutMs(),
  )
  if (!releaseOpenLock) {
    throw new Error(`事件库打开锁获取超时（另一进程正在迁移会话库），本进程首开 ${dbPath} 失败——可重试`)
  }
  try {
    // 拿到锁后双检缓存：等待窗内另一 openSessionStoreAsync/OpenTo 壳可能已完成首开
    // 并登记——直接复用，不重复建库/跑 DDL/起开口标记
    const again = openStores.get(dbPath)
    if (again && !again.closed) {
      again.refs++
      return again.store
    }
    return firstOpenStore(bookRoot, dir, dbPath)
  } finally {
    releaseOpenLock()
  }
}

/** R34D-19（三十四轮）：首开核心（建库 + DDL + 孤儿修复 + 开口标记 + 登记缓存）——
 *  自 openSessionStore 抽出，同步/异步两个开库壳共用（防两壳各持一份 DDL/修复逻辑
 *  漂移）；调用方须已持 session 迁移锁，锁释放归开库壳（同步壳/异步壳各自的 finally
 *  releaseOpenLock）——首开核心自身无锁可放。
 *  WAL 切换退避（SQLITE_BUSY 重试）内的 Atomics.wait 微睡 ≤1.8s 有界保留：首开段
 *  已被迁移锁跨进程串行化，退避仅在他进程**已开库连接**持写锁的窗口触发，且
 *  DatabaseSync 的 DDL 序列是同步共用面不宜双轨化（收口记登记）。
 *  残留清偿批（三十四轮）复核维持：busy_timeout=5000 本身使 db.exec 在 SQLite
 *  内部同步等待——微睡异步化不消除真阻塞源（node:sqlite 无异步 API），双轨化只
 *  增 DDL 漂移面。此为本链同步残留登记中唯一的「不可异步化」架构项。
 *  R0916-7-P3-2（2026-09-25 评审 P3-2）：按职责拆为可命名单元——迁移墓碑
 *  （clearStaleMigrationTombstone）/ 打开期 PRAGMA 与 WAL（applyOpenPragmas）/
 *  DDL（createEventsSchema）/ 打开全流程错误收口（openEventsDbWithDdl）/
 *  预置与修复（repairOrphanSessions + 开口标记续期 + maybeRepairOrphans）/
 *  方法族按职责分组（createWriteMethods 等四个分组工厂）。对外句柄形状与行为不变。 */
/** IR-2（独立重评 2026-09-02）：SQLite 库文件损坏类错误判据——node:sqlite 对
 *  SQLITE_NOTADB/CORRUPT 抛英文裸 message 且各版本措辞有差，按已知短语集匹配；
 *  宁可漏判走原样上抛，不误判把 BUSY/IOERR 包装成「损坏」。 */
function isDbCorruptionError(e: unknown): boolean {
  const msg = errMsg(e)
  return /file is not a database|database disk image is malformed|malformed database image|unsupported file format/i.test(
    msg,
  )
}

/** R67-2（十五轮）：旧路径库文件缺失 + 墓碑在位 = 该库曾随书改名迁走——分两态：
 *  旧书根目录已不存在（书确实改名迁走，stale 书目录视图的进程迟来首开）且墓碑
 *  指向的新库还活着 → fail-closed 抛错拒建空库（建空库会让事件流分裂成两半，走
 *  调用方既有 catch 降级 null）；旧根目录又在（同路径重新建书）或新库也已不存在
 *  （再迁移/已删书）→ 墓碑过期，清除后放行正常新建。
 *  R0916-7-P3-2：导出供回归直测（生产唯一调用点在 firstOpenStore 首开头）。 */
export function clearStaleMigrationTombstone(bookRoot: string, dbPath: string): void {
  if (existsSync(dbPath) || !existsSync(dbPath + MIGRATED_EXT)) return
  let to: unknown = null
  try {
    to = (JSON.parse(readFileSync(dbPath + MIGRATED_EXT, 'utf-8')) as { to?: unknown }).to
  } catch {
    // R41-11（四十一轮）：墓碑不可解析（写中途进程死留下的半截 JSON——写侧已改
    // atomicWriteFile 杜绝新发，此为存量/外因形态）不当作「无墓碑」清除放行：
    // 清除后本处按正常缺库重建空库，事件流在新旧两路径分裂（R71-25 要防的正是
    // 这个）。保留墓碑 + fail-closed 拒建，走调用方既有 catch 降级 null；作者按
    // 告警人工核对迁移目标（修复墓碑 JSON 或确认旧库确已废弃后手删）。
    log.error(
      'events',
      `事件库迁移墓碑不可解析（${dbPath + MIGRATED_EXT}）——保留墓碑并拒绝在旧路径重建空库，请人工核对迁移目标（合法形：${'{ to: <新库绝对路径>, at: <毫秒> }'}）`,
    )
    throw new Error(`事件库迁移墓碑不可解析（${dbPath + MIGRATED_EXT}）——拒绝在旧路径重建空库，请人工核对/修复墓碑后重试`)
  }
  if (!existsSync(bookRoot) && typeof to === 'string' && to !== '' && existsSync(to)) {
    throw new Error(
      `事件库已随书改名迁移（${dbPath} → ${to}）——拒绝在旧路径重建空库，请以改名后的书访问`,
    )
  }
  try {
    rmSync(dbPath + MIGRATED_EXT, { force: true })
  } catch {
    /* 清除失败维持原样：下次首开再试 */
  }
}

/** 打开期 PRAGMA + WAL 切换（须在 DDL 之前）：busy_timeout 必须先于 journal_mode=WAL
 *  设置——WAL 切换在 journal_mode 处需拿写锁，若另一进程正持锁而 busy_timeout 未设，
 *  会立即抛 SQLITE_BUSY（N3 五十九轮三进程并发首开回归在全量并发下偶发红的根因）。
 *  R0916-7-P3-2：导出供回归直测（生产唯一调用点在 openEventsDbWithDdl 首开段）。 */
export function applyOpenPragmas(db: DatabaseSync): void {
  // N3（五十九轮）补：busy_timeout 先设（见上）
  db.exec('PRAGMA busy_timeout = 5000')
  // R73-48（二十一轮·裁定维持不加深退避）：审查项「8 次退避耗尽仍可抛 SQLITE_BUSY」
  // ——耗尽即抛是 fail-closed 正确出口，不是缺陷：每轮失败前 busy_timeout 已在
  // SQLite 内部等待 5s，8 轮 × 5s + 退避 1.8s ≈ 42s 仍抢不到，说明对手是僵死
  // 写方（SIGSTOP 挂起/磁盘级卡死），再等只会把「打开失败可重试」拖成分钟级假死；
  // 抛错走调用方既有 catch 降级 null，无数据损伤。维持 8 次 + 线性退避现状。
  // N3（五十九轮）：WAL 切换需短暂独占——并发首开下其他进程持锁（DDL/首写）时，
  // 即使 busy_timeout 也可能立即 SQLITE_BUSY 且库仍处 delete 态（幂等 no-op 兜底
  // 不够）。带退避重试：对方事务必然短（建表/一次 INSERT），数百 ms 内可得手。
  let lastErr: unknown
  for (let i = 0; i < 8; i++) {
    try {
      db.exec('PRAGMA journal_mode = WAL')
      lastErr = null
      break
    } catch (err) {
      // IR-2：库损坏是确定性错误，退避重试只会空转 8×（busy_timeout 5s 内部
      // 等待 + 微睡）——立即上抛走外层分类包装（含可行动指引）
      if (isDbCorruptionError(err)) throw err
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

/** 首开 DDL：events / sessions 建表 + 检索索引 + 分支元数据生成列（0918四轮修复批 B401）。
 *  R0916-7-P3-2：导出供回归直测（生产唯一调用点在 openEventsDbWithDdl 首开段）。 */
export function createEventsSchema(db: DatabaseSync): void {
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
  // ── 0918四轮修复批（B401）：分支元数据检索列 + 部分索引 ──
  // firstBranchMetaSeq 原 `data LIKE '%"branchId"%' OR LIKE '%"parentSeq"%'` 谓词无
  // 可用索引，chat-history 真尾窗每次请求全表扫描（node:sqlite 同步 API 直接停在
  // 事件循环上，翻倍前扩循环里最坏反复全扫）。改 VIRTUAL 生成列（instr 确定性函数，
  // 读时零存储按行求值）+ 部分索引（只收录携带分支元数据的行，体量 = 分支事件数级，
  // 与全表行数解耦）。存量库惰性迁移：PRAGMA table_xinfo 判列后 ALTER 补列（幂等，
  // 首开一次 ALTER O(1) 元操作 + 建索引一次全行扫描），新库建表（上方，无此列）同样
  // 走到本处补齐——单点单路径防新旧两态 schema 漂移。ALTER 生成列须 SQLite ≥3.31
  // （node:sqlite 内建版远高于此，见分支 meta 索引回归用例的实证断言）；若未来
  // node:sqlite 拒绝 ALTER 加生成列，回退方案 = 独立 branch_meta 影子表（本批未采）。
  {
    // 判列必须走 table_xinfo——生成列是 hidden 列（hidden=2），table_info 不列出
    //（误判缺列会让每次重开库都重跑 ALTER 撞 duplicate column）
    const cols = db.prepare('PRAGMA table_xinfo(events)').all() as Array<{ name: string }>
    if (!cols.some((c) => c.name === 'has_branch_meta')) {
      db.exec(
        `ALTER TABLE events ADD COLUMN has_branch_meta INTEGER GENERATED ALWAYS AS
         (instr(data, '"branchId"') > 0 OR instr(data, '"parentSeq"') > 0) VIRTUAL`,
      )
    }
  }
  db.exec('CREATE INDEX IF NOT EXISTS idx_events_branch_meta ON events(session_id, seq) WHERE has_branch_meta = 1')
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
}

/** R34D-19（三十四轮）首开全流程（建目录 + 开库 + PRAGMA/WAL + DDL + 孤儿修复 +
 *  开口标记登记）：打开期（PRAGMA/DDL/孤儿修复）抛错时句柄不滞留——此刻尚未登记
 *  openStores，引用计数的 close 回收路径接不到它；调用方 catch 后降级 null 继续跑，
 *  句柄滞留进程积累（「损坏库重试」类测试反复触发尤甚）。 */
function openEventsDbWithDdl(dir: string, dbPath: string): { db: DatabaseSync; markerTimer: ReturnType<typeof setInterval> } {
  mkdirSync(dir, { recursive: true })
  const db = new DatabaseSync(dbPath)
  try {
    applyOpenPragmas(db)
    createEventsSchema(db)
    repairOrphanSessions(db, activeChatSessions)
    // R67-2：首开成功（DDL/修复全过）→ 落开口标记（仍在目录锁内，与迁移扫描互斥）。
    // 放在 repair 之后：打开期抛错则不登记（句柄已在 catch 关闭）。
    registerOpenMarker(dir, dbPath)
    // R71-24：起续期定时器——活句柄定期刷标记 mtime；进程挂死/崩溃后停止续期，
    // 超龄标记在扫描时按 pid 复用残留 GC（见 sweepOpenMarkers）。unref 不阻退出。
    // 打开期抛错则不启动（标记登记在 repair 之后，异常路径无续期定时器可留）。
    const markerTimer = setInterval(() => touchOpenMarker(dbPath), OPEN_MARKER_RENEW_MS)
    markerTimer.unref()
    return { db, markerTimer }
  } catch (e) {
    try {
      closeEventsDb(db)
    } catch {
      /* best-effort：close 自身失败不再遮蔽原始错误 */
    }
    // IR-2（独立重评 2026-09-02）：库文件损坏原样上抛裸 SQLite 码（「file is not
    // a database」），调用方降级 null 后用户只看到「事件库不可用」无任何可行动
    // 线索。事件是对话史/审计产品数据，不做静默删库自愈——换含路径与恢复指引的
    // 人话错误（原始错误挂 cause 保诊断链），经 chat-history 族结构化 500 透传。
    if (isDbCorruptionError(e)) {
      throw new Error(
        `事件库文件损坏（${dbPath}），对话史/审计/链路事件暂不可读。` +
          `请先备份并移走该文件后重试——应用将重建空库（旧事件记录不会自动恢复）`,
        { cause: e },
      )
    }
    throw e
  }
}

function firstOpenStore(bookRoot: string, dir: string, dbPath: string): SessionStore {
  // R0916-7-P3-2：迁移墓碑判定（旧路径拒建空库 / 过期清除）先于建库
  clearStaleMigrationTombstone(bookRoot, dbPath)
  const { db, markerTimer } = openEventsDbWithDdl(dir, dbPath)
  // R66-12：登记/挂缓存段不碰库文件（纯内存，轻快）；R51-B-1（五十一轮）注释勘误——
  // 本段实际仍在首开锁内执行（firstOpenStore 全程持 session 迁移锁，锁释放归开库壳
  // finally，openStores.set 在本函数末尾、锁释放前）。原注「留在锁外」与实态相反，
  // 会误导后续维护者：锁内登记正是异步壳拿锁后双检缓存（openSessionStoreAsync 拿锁
  // 再查 openStores）能命中先到者的前提——若据此「锁外」表述把登记挪到锁外或删双检，
  // 会重开双进程并发首开的重复建库窗口。勿改时序。
  const entry: StoreEntry = { store: null!, refs: 1, closed: false, lastOrphanRepairAt: Date.now(), markerTimer }
  const ctx: StoreCtx = { db, dbPath, entry }
  /** R0916-7-P3-2：方法族按职责分组装配（写入 / 读 / 会话行 / 维护）——分组内的声明
   *  顺序即对外 Object.keys 顺序（与拆分前的单一字面量逐位一致），勿调整分组次序。 */
  const store: SessionStore = {
    dbPath,
    ...createWriteMethods(ctx),
    ...createReadMethods(ctx),
    ...createSessionQueryMethods(ctx),
    ...createMaintenanceMethods(ctx),
  }
  entry.store = store
  openStores.set(dbPath, entry)
  return store
}

/** R0916-7-P3-2：store 方法族的公共上下文（连接句柄 + 库路径 + 引用计数条目）。 */
interface StoreCtx {
  db: DatabaseSync
  dbPath: string
  entry: StoreEntry
}

/** 预置与修复：写路径惰性孤儿修复（TTL = ORPHAN_GRACE_MS，至多每 32 分钟一次）：
 *  打开时仍在宽限期内的崩溃残留，宽限期过后随下一次会话写入补 end——无需等进程重开库。
 *  R53-B-3（五十三轮）：触发点收敛到 createSession——原挂在 createSession/
 *  appendEvents/appendEventsResolveLineage 三处（每批事件都过 Date.now 闸，TTL
 *  到期后的那一笔还要先扛完整的分页扫描 + 逐孤儿 BEGIN IMMEDIATE），热路径写放大
 *  与锁持有面偏大。createSession 是低频用户可见动作（新开一次对话），修复语义
 *  不变（打开期修一次 + 32 分钟 TTL 惰性续修）；代价：马拉松单会话数小时不新开
 *  对话时，他进程崩溃残留的补 end 推迟到下次新开对话/重开库——审计收尾本就非
 *  当前写正确性所系，取舍可接受（如实记档）。 */
function maybeRepairOrphans(ctx: StoreCtx): void {
  if (Date.now() - ctx.entry.lastOrphanRepairAt < ORPHAN_GRACE_MS) return
  ctx.entry.lastOrphanRepairAt = Date.now()
  repairOrphanSessions(ctx.db, activeChatSessions)
}

/** 语句准备：B2（复审-0914-优化修复批）：listEvents/iterateEvents 的 SQL 装配单源——
 *  两方法原 2×2 分支（按会话/按书 × 物化/流式）逐字同构，抽出本生成器后两方法只剩
 *  物化/流式编排差异。查询结果与坏行降级（safeRowToEvent，R65-20）逐位同旧实现；
 *  label 随调用方传入保告警可归因。唯一文本归一：原 listEvents 无 limit 变体的
 *  ORDER BY 尾随空格去除（prepared 缓存以 SQL 串为键，键文本稳定即无行为面）。
 *  cap 语义沿 O-2：仅正有限数生效（向下取整），否则全量。 */
function* queryEventRows(
  ctx: StoreCtx,
  book: string,
  sessionId: string | undefined,
  cap: number | undefined,
  type: EventType | undefined,
  label: 'listEvents' | 'iterateEvents',
): Generator<ChatEvent> {
  const db = ctx.db
  if (sessionId) {
    const args: Array<string | number> = [sessionId]
    if (type !== undefined) args.push(type)
    if (cap !== undefined) args.push(cap)
    // R46-42：读热路径固定/有界变体 SQL 走 prepared 缓存（变体以 SQL 串为键独立缓存）
    // R0916-P3-11（四轮处置批）：iterateEvents 长生命周期生成器改每次新编译语句——
    // 此前共用缓存语句，重入（外层迭代未完时再开同 SQL 迭代）会令外层迭代器被
    // node:sqlite 判失效（ERR_INVALID_STATE，实证见 test/events r0916 用例）；
    // listEvents 在表达式内同步排干生成器、语句生命周期不越出单次调用，保留缓存收益。
    // streaming 路径的编译成本（µs 级）相对全表扫描可忽略（readAllChunks 同款先例）。
    const sql = `SELECT * FROM events WHERE session_id = ? ${type !== undefined ? 'AND type = ?' : ''} ORDER BY seq ASC${cap !== undefined ? ' LIMIT ?' : ''}`
    const rows = (label === 'iterateEvents' ? db.prepare(sql) : prepared(db, sql))
      .iterate(...args) as unknown as Iterable<Row>
    for (const r of rows) {
      const ev = safeRowToEvent(r, label)
      if (ev) yield ev
    }
    return
  }
  const args: Array<string | number> = [book]
  if (type !== undefined) args.push(type)
  if (cap !== undefined) args.push(cap)
  // R0916-P3-11：同上——iterateEvents 新编译、listEvents 走缓存（SQL 单源本处一份）
  const sql = `SELECT * FROM events
     WHERE session_id IN (SELECT session_id FROM sessions WHERE book = ?) ${type !== undefined ? 'AND type = ?' : ''}
     ORDER BY seq ASC${cap !== undefined ? ' LIMIT ?' : ''}`
  const rows = (label === 'iterateEvents' ? db.prepare(sql) : prepared(db, sql))
    .iterate(...args) as unknown as Iterable<Row>
  for (const r of rows) {
    const ev = safeRowToEvent(r, label)
    if (ev) yield ev
  }
}
/** 写入面方法族：会话创建 + 事件批写（R0916-7-P3-2 自巨型对象字面量按职责切出；
 *  方法体逐字未动，仅把原闭包捕获的 db 改为显式上下文）。 */
function createWriteMethods(ctx: StoreCtx): Pick<SessionStore, 'createSession' | 'appendEvents' | 'appendEventsResolveLineage'> {
  const db = ctx.db
  return {
    createSession(book: string, header?: Record<string, unknown>): string {
      maybeRepairOrphans(ctx)
      const sid = ulid()
      const now = Date.now()
      // R46-42：固定 SQL 走连接级 prepared 缓存（每会话一条，编译一次复用）
      prepared(
        db,
        `INSERT INTO sessions (session_id, format_version, book, header, created_at, updated_at)
         VALUES (?, 1, ?, ?, ?, ?)`
      ).run(sid, book, JSON.stringify(header ?? {}), now, now)
      return sid
    },
    appendEvents(sessionId: string, evs: NewEvent[]): number[] {
      const now = Date.now()
      // RB-IF-P1-2：INSERT RETURNING 取真实 seq——close() 写 compaction 事件后据此
      // 定位 archiveSeq，不再 lastSeq()+2 推算（多窗口并发写时可错链到别窗事件）
      // R46-42：每批热路径的固定 SQL 改 prepared 缓存（原每批重编译 INSERT+UPDATE 两条）
      const ins = prepared(
        db,
        `INSERT INTO events (session_id, turn, step, type, data, surface_op, shadow_start, shadow_end, source_seqs, replace_generation, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?) RETURNING seq`
      );
      const touch = prepared(db, 'UPDATE sessions SET updated_at = ? WHERE session_id = ?')
      // P3-9：sessions.updated_at 挪进主事务——此前在 COMMIT 之后单独 UPDATE，若失败会
      // 误报「写失败」且客户端重试产生重复事件；现在与事件落库同事务，要么都成功要么都回滚。
      return withEventsTx(db, () => {
        const seqs: number[] = []
        for (const e of evs) {
          const row = ins.get(sessionId, e.turn ?? null, e.step ?? null, e.type, JSON.stringify(e.data),
            e.surfaceOp ?? null, e.shadowStart ?? null, e.shadowEnd ?? null,
            e.sourceSeqs ? JSON.stringify(e.sourceSeqs) : null, now) as { seq: number }
          seqs.push(row.seq)
        }
        touch.run(now, sessionId)
        return seqs
      })
    },
    // AA-P3-7：INSERT RETURNING 取真实 seq，sourceIdxs 批内索引同事务回写解析——
    // 血缘不再依赖 lastSeq()+批内序号推算（多窗口并发写事件库时可能错链到别窗的 seq）
    appendEventsResolveLineage(sessionId: string, evs: NewEvent[]): number[] {
      const now = Date.now()
      // R46-42：同 appendEvents——三条固定 SQL 改 prepared 缓存
      const ins = prepared(
        db,
        `INSERT INTO events (session_id, turn, step, type, data, surface_op, shadow_start, shadow_end, source_seqs, replace_generation, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, 0, ?) RETURNING seq`
      )
      const upd = prepared(db, 'UPDATE events SET source_seqs = ? WHERE session_id = ? AND seq = ?')
      const touch = prepared(db, 'UPDATE sessions SET updated_at = ? WHERE session_id = ?')
      return withEventsTx(db, () => {
        const seqs: number[] = []
        for (const e of evs) {
          const row = ins.get(
            sessionId, e.turn ?? null, e.step ?? null, e.type, JSON.stringify(e.data),
            e.surfaceOp ?? null, e.shadowStart ?? null, e.shadowEnd ?? null, now,
          ) as { seq: number }
          seqs.push(row.seq)
        }
        // 血缘回写：批内索引（0-based 同批前驱引用）→ 真实全局 seq，与插入同事务。
        // hh §八-18：越界索引 = 生产者 bug——显式抛错回滚整批（宁可红不可错），
        // 绝不把 seqs[s]! 断言掩盖的 undefined 序列化成 null 血缘静默写库
        evs.forEach((e, idx) => {
          // R26-20（二十六轮）：拒收 sourceSeqs——本方法只认批内索引 sourceIdxs；
          // sourceSeqs 语义已收窄为「全局 seq」（appendEvents 原样落库专用）。此前两路
          // 同名双语义（全局 seq vs 批内 0-based 索引）靠调用方自觉区分，传错即静默
          // 错链；现宁可红不可错：传了即抛错回滚整批，文案说明双语义陷阱。
          if (e.sourceSeqs !== undefined) {
            throw new Error(
              `appendEventsResolveLineage：事件 ${idx}「${e.type}」带了 sourceSeqs（全局 seq 语义，仅 appendEvents 原样落库用）——本方法按批内索引解析血缘，请改传 sourceIdxs（R26-20 双语义拆分）`,
            )
          }
          const idxs = e.sourceIdxs
          if (idxs && idxs.length > 0) {
            for (const s of idxs) {
              if (!Number.isInteger(s) || s < 0 || s >= seqs.length) {
                throw new Error(
                  `appendEventsResolveLineage：批内 sourceIdxs 索引非法（${s}，批大小 ${seqs.length}）——事件 ${idx}「${e.type}」血缘引用越界`,
                )
              }
            }
            const resolved = idxs.map((s) => seqs[s]!)
            upd.run(JSON.stringify(resolved), sessionId, seqs[idx]!)
          }
        })
        touch.run(now, sessionId)
        return seqs
      })
    },
  }
}

/** 读面方法族：全量/尾窗/计数/分支边界/流式读（语句准备见 queryEventRows 单源）。 */
function createReadMethods(
  ctx: StoreCtx,
): Pick<SessionStore, 'listEvents' | 'listEventsTail' | 'countEvents' | 'firstBranchMetaSeq' | 'iterateEvents'> {
  const db = ctx.db
  return {
    listEvents(book: string, sessionId?: string, limit?: number, type?: EventType): ChatEvent[] {
      // O-2（第十三轮）：limit 可选限量（seq 升序前 N）；投影折叠调用方不传（全量语义不变）
      // 内存闸（2026-08-24 审计 B1）双降：①type 可选 SQL 下推——trace/cost 聚合只取
      // llm/call 小字段行，不再把全部对话正文一起载入解析；②游标 iterate 逐行 parse
      // ——原 stmt.all() 先物化全部行（data JSON 串一份）再 map JSON.parse 出第二份，
      // 双份共存峰值 ≈2× 表字节，与 rag readAllChunks 同修法
      // B2（复审-0914-优化修复批）：SQL 装配/坏行降级单源 queryEventRows，本方法只承担
      // cap 解析 + 物化数组（R65-20 坏行降级见 safeRowToEvent）。
      const cap = typeof limit === 'number' && Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : undefined
      return [...queryEventRows(ctx, book, sessionId, cap, type, 'listEvents')]
    },
    // ── 0917清库修复批：真尾窗三原语实现（接口处注释为设计正本）──
    listEventsTail(book: string, tail: number): ChatEvent[] {
      const cap = typeof tail === 'number' && Number.isFinite(tail) && tail > 0 ? Math.floor(tail) : 0
      if (cap === 0) return []
      // 降序取尾 + 反转升序；R0916-P3-11 同款：表达式内同步排干生成器，走 prepared 缓存
      const rows = prepared(
        db,
        `SELECT * FROM events
         WHERE session_id IN (SELECT session_id FROM sessions WHERE book = ?)
         ORDER BY seq DESC LIMIT ?`,
      ).iterate(book, cap) as unknown as Iterable<Row>
      const out: ChatEvent[] = []
      for (const r of rows) {
        const ev = safeRowToEvent(r, 'listEventsTail')
        if (ev) out.push(ev)
      }
      return out.reverse()
    },
    countEvents(book: string): number {
      const row = prepared(
        db,
        `SELECT COUNT(*) AS n FROM events
         WHERE session_id IN (SELECT session_id FROM sessions WHERE book = ?)`,
      ).get(book) as { n: number }
      return row.n
    },
    firstBranchMetaSeq(book: string): number | null {
      // 0918四轮修复批（B401）：`data LIKE … OR LIKE …` 谓词改走 has_branch_meta 生成列
      // ——EXPLAIN QUERY PLAN 实证 SEARCH events USING INDEX idx_events_branch_meta
      // （部分索引只含分支元数据行，不再全表扫；契约不变：min seq 或 null，误报方向安全）。
      // 0918独立重评修复批（C002）：裸 db.prepare 收编 prepared() 连接级缓存（SQL 文本
      // 固定；R0911b-E-P3-1 同款，latestSession 先例）
      const row = prepared(
        db,
        `SELECT MIN(seq) AS s FROM events
         WHERE session_id IN (SELECT session_id FROM sessions WHERE book = ?)
           AND has_branch_meta = 1`,
      ).get(book) as { s: number | null }
      return row.s ?? null
    },
    *iterateEvents(book: string, sessionId?: string, type?: EventType): IterableIterator<ChatEvent> {
      // R0910-W（2026-09-10 修复批）：流式读（不物化）——llm/call 分析读侧（cost/trace
      // 聚合）此前经 listEvents 把整段过滤集（重书数十万行 data JSON 解析成对象）堆进
      // 数组，每次指标刷新峰值巨大；本生成器逐行 yield，调用方边读边聚合，峰值只与
      // 聚合桶规模相关。SQL 与 listEvents 无 limit 变体逐字同构（seq 升序 = 时间序，
      // 聚合结果与全量读逐字段一致）；坏行降级沿用 safeRowToEvent（R65-20）。调用方
      // 负责 close（与 listEvents 同约定）；提前 break 时游标随 GC 回收，无悬挂。
      // B2（复审-0914-优化修复批）：SQL 装配/坏行降级单源 queryEventRows，本方法只承担
      // 逐行 yield（不物化）。
      yield* queryEventRows(ctx, book, sessionId, undefined, type, 'iterateEvents')
    },
  }
}

/** 会话行面方法族：工作区会话惰性创建 / 最新会话 / 最大 seq / 遮蔽自检数据源。 */
function createSessionQueryMethods(
  ctx: StoreCtx,
): Pick<SessionStore, 'workspaceSession' | 'latestSession' | 'lastSeq' | 'maskSelfCheckData'> {
  const db = ctx.db
  return {
    workspaceSession(book: string): string {
      // N3（五十九轮）：SELECT→INSERT 包 BEGIN IMMEDIATE——双进程并行首开同书时，原裸
      // SELECT→INSERT 竞态会分裂两个 ws 会话（链路事件分裂写入两处）。IMMEDIATE 拿写锁
      // 后 SELECT→INSERT 原子化：后到进程的 BEGIN IMMEDIATE 在 busy_timeout 内等待，
      // 拿锁后重查必见先到者已 INSERT 的行 → 复用同一 ws 会话。
      // 未加 (book, ws-) 唯一约束：sessions 表既有库可能已有历史重复 ws 行（先查重再建
      // 索引会破坏「不动既有库」边界），事务串行化已闭合分裂窗口。
      db.exec('BEGIN IMMEDIATE')
      try {
        // R46-42：SELECT+INSERT 固定对走 prepared 缓存（每链路事件写均经此）
        const row = prepared(
          db,
          `SELECT session_id FROM sessions WHERE book = ? AND session_id LIKE 'ws-%' LIMIT 1`
        ).get(book) as { session_id: string } | undefined
        if (row) {
          db.exec('COMMIT')
          return row.session_id
        }
        const sid = `ws-${ulid()}`
        const now = Date.now()
        prepared(
          db,
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
      // R0911b-E-P3-1：改道连接级 prepared 语句缓存（原裸 db.prepare 每调重编译，
      // 绕过全库统一 helper；本函数当前零生产调用，导出保留）
      const r = prepared(
        db,
        `SELECT * FROM sessions WHERE book = ? AND session_id NOT LIKE 'ws-%' ORDER BY updated_at DESC, rowid DESC LIMIT 1`
      ).get(book) as SessionRow | undefined
      return r ?? null
    },
    lastSeq(): number {
      // R46-42：recorder 写前算区间的固定查询走 prepared 缓存
      const row = prepared(db, 'SELECT MAX(seq) AS m FROM events').get() as { m: number | null }
      return row.m ?? 0
    },
    maskSelfCheckData(from: number, to: number) {
      // R66-16（十四轮）：close 写 compaction 前的遮蔽区间自检数据源——不做投影全量
      // 重放（validateEventStream 的生产接线最小面）。区间重叠判定：
      // 既有 [s,e] 与 [from,to] 相交 ⟺ s <= to && e >= from
      // R59 清偿批（R55-B-2）登记：上注原称「O(1) 索引查询」失实——events 表唯一索引
      // 是 idx_events_session(session_id, seq)，本查询按 surface_op + shadow 区间过滤
      // 无可用索引，实为全表扫（O(N)，N = 全库事件数）。不设新索引的取舍：随开库 DDL
      // 加 partial index 需对存量用户库做开库期 schema 变更（首次建索引的写锁窗叠打开期
      // 成本敏感面，见 N3 五十九轮并发首开注），而本查询仅在 close 写 compaction 前执行
      // 一次（低频诊断面，毫秒级一次性窗）——性能收益不抵迁移风险，登记不修；后续若
      // close 链实测成瓶颈再单立迁移项评估。
      // 0918独立重评修复批（C002）：两条固定 SQL 收编 prepared()（第二条的 IN 占位符
      // 拼自 SURFACE_EVENT_TYPES 常量集——变体数恒 1，符合「变体数须有界」入缓契约）
      const intervals = (
        prepared(
          db,
          `SELECT shadow_start AS start, shadow_end AS end FROM events
           WHERE surface_op = 'replace' AND shadow_start IS NOT NULL AND shadow_end IS NOT NULL
             AND shadow_start <= ? AND shadow_end >= ?`,
        )
          .all(to, from) as Array<{ start: number; end: number }>
      ).map((r) => ({ start: r.start, end: r.end }))
      const surfaceTypes = [...SURFACE_EVENT_TYPES]
      const ph = surfaceTypes.map(() => '?').join(',')
      const rows = prepared(
        db,
        `SELECT seq, type, data FROM events WHERE seq >= ? AND seq <= ? AND type IN (${ph}) ORDER BY seq`,
      ).all(from, to, ...surfaceTypes) as Array<{ seq: number; type: string; data: string }>
      return { intervals, rows }
    },
  }
}

/** 维护面方法族：多 book 键清理 + 引用计数关库。 */
function createMaintenanceMethods(ctx: StoreCtx): Pick<SessionStore, 'clearBook' | 'clearBooks' | 'close'> {
  const { db, dbPath, entry } = ctx
  return {
    clearBook(book: string): void {
      // RB-IF-P2-1：两条 DELETE 同事务（对齐同文件其他写路径）——中途失败/崩溃
      // 不留「events 已删、sessions 残留」的孤儿（孤儿 events 永久查不到，审计丢失）
      // 0918独立重评修复批（C002）：两条固定 DELETE 收编 prepared() 连接级缓存
      withEventsTx(db, () => {
        prepared(
          db,
          `DELETE FROM events WHERE session_id IN (SELECT session_id FROM sessions WHERE book = ?)`
        ).run(book)
        prepared(db, 'DELETE FROM sessions WHERE book = ?').run(book)
      })
    },
    clearBooks(books: string[]): void {
      // 低级项（第六轮）：多 book 键单事务清理——audit DELETE / chat 清史都是
      // bookName + bookHash 双钥匙，两次 clearBook 各自事务：第二键失败时第一键已提交，
      // 两侧一半清一半留。单 BEGIN 内循环两键的 DELETE，要么全清要么全不动
      withEventsTx(db, () => {
        // 0918独立重评修复批（C002）：循环内裸 db.prepare 收编——语句提循环外经
        // prepared() 取缓存（原每 book 每轮重编译两条固定 DELETE）
        const delEvents = prepared(
          db,
          `DELETE FROM events WHERE session_id IN (SELECT session_id FROM sessions WHERE book = ?)`
        )
        const delSessions = prepared(db, 'DELETE FROM sessions WHERE book = ?')
        for (const book of books) {
          delEvents.run(book)
          delSessions.run(book)
        }
      })
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
        // R71-24：先停续期再注销——反序会让注销后的下一个 tick 重新写出标记（自愈路径
        // 把「已关库」又声明成「在位」，迁移扫描误拒）。
        // R38-15（三十八轮）：停表/注销再提前到 db.close() 之前，且 close 包 try/catch——
        // 原序 db.close() 一旦抛错（node:sqlite 罕见但可能）下方两行不可达：markerTimer
        // 永久续期把开口标记持续「复活」，sweepOpenMarkers 的超龄判死永不触发，该书
        // 迁移被无限期拒。
        if (entry.markerTimer) clearInterval(entry.markerTimer)
        // R67-2：引用归零真关库 → 注销开口标记（迁移扫描从此看不见本进程）
        releaseOpenMarker(dbPath)
        try {
          closeEventsDb(db)
        } catch (e) {
          // close 失败只留痕：停表/注销已正确收口，句柄由进程退出兜底回收
          log.warn('events', `事件库关闭异常（${dbPath}）：${errMsg(e)}`)
        }
      }
    },
  }
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
export async function migrateBookSession(
  userDataPath: string | null | undefined,
  oldRoot: string,
  newRoot: string,
  oldName: string,
  newName: string,
): Promise<boolean> {
  if (!userDataPath) return true
  const dir = join(userDataPath, 'clwriting', 'session')
  const oldDb = join(dir, bookHash(oldRoot) + '.db')
  const newDb = join(dir, bookHash(newRoot) + '.db')
  if (oldDb === newDb) return true
  // R66-12（十四轮）：迁移整段（在途断言→checkpoint→搬移→改钥匙）进 session 跨进程
  // 锁，与 openSessionStore 首开段互斥——此前只挡本进程在途引用（openStores），
  // 另一进程（第二个 studio 实例/CLI）恰在 checkpoint 与 rename 之间首开旧库时，SQLite
  // 会在旧路径重建空库（旧 hash 下历史「清零」）或对半搬文件集跑 DDL（撕裂态）。
  // 超时放弃（false）：源库原地完整可重试，与既有失败语义一致。
  // R73-38：新旧路径两把 per-book 锁（bookHash 排序获取，见 acquireMigrateLockPair）——
  // 首开旧库对 lock(old)、首开新库对 lock(new)，rename 窗口两侧都不再漏。
  // R31-23（三十一轮）：锁获取异常（EACCES/只读卷等非 EEXIST 故障会 throw）收口为
  // false——函数契约「false = 迁移失败可重试」，此前裸异常穿到 books.ts 改名端点。
  // R34D-19（三十四轮）：函数转 async（books.ts 改名端点/测试两处调用方随迁）——
  // 迁移锁对（acquireMigrateLockPairAsync）等待不再阻塞服务进程事件循环。
  let releaseMigrateLock: (() => void) | null = null
  try {
    releaseMigrateLock = await acquireMigrateLockPairAsync(userDataPath, oldRoot, newRoot)
  } catch (e) {
    log.warn('events', `事件库迁移锁获取失败（${errMsg(e)}）——放弃本轮，源库原地完整可重试`)
    return false
  }
  if (!releaseMigrateLock) {
    log.warn('events', '事件库迁移锁获取超时（另一进程正在迁移/首开同书会话库）——放弃本轮，源库原地完整可重试')
    return false
  }
  // 已完成搬移的记录（from=源位 to=新位）：任一步失败时逆序搬回，保证源库原地完整
  const moves: Array<{ from: string; to: string }> = []
  // R32-4（三十二轮）：钥匙改写抽闭包——迁移第 4 步与半迁移态自愈共用。幂等：两条
  // UPDATE 的 WHERE 只匹配仍持旧钥匙的行（对话书名 / 工作区 hash），已改行不再命中，
  // 重复补跑零副作用。kk-P2-4：busy_timeout 先于 BEGIN——同进程连接已全关，但另一
  // 进程（第二个 studio 实例）若恰在此窗口打开新库，裸 BEGIN 会立刻 SQLITE_BUSY 而非等待。
  const rewriteSessionKeys = (): void => {
    const db = new DatabaseSync(newDb)
    try {
      db.exec('PRAGMA busy_timeout = 5000')
      db.exec('BEGIN')
      // 0918独立重评修复批（C002）：裸 db.prepare 收编 prepared()（一次性迁移连接亦统一
      // 走 helper——连接关库走 closeEventsDb，缓存条目随配对注销，无滞留面）
      prepared(db, 'UPDATE sessions SET book = ? WHERE book = ?').run(newName, oldName)
      prepared(db, 'UPDATE sessions SET book = ? WHERE book = ?').run(bookHash(newRoot), bookHash(oldRoot))
      db.exec('COMMIT')
    } finally {
      // 未 COMMIT 的事务随连接关闭回滚（先关干净再让异常冒泡去回滚文件搬移）
      closeEventsDb(db)
    }
  }
  try {
    if (!existsSync(oldDb)) {
      // R32-4（三十二轮）：半迁移态自愈——「rename 成功（3）→ 钥匙 UPDATE 未及 COMMIT
      // （4）」的崩溃窗此前被本早退吞掉（return true 视作已完成、永不补跑），新库在位但
      // 两把钥匙仍旧名：对话史/工作区事件视图在新旧两头都查不到（「消失」无自愈）。
      // 墓碑在位 + 新库存在 = 该窗文件特征（成功路径碑同样留存，但补跑幂等无害）：
      // 幂等补跑两条 UPDATE。R71-25 墓碑只挡旧路径重建空库，不治新库钥匙——本分支
      // 补的是另一半。补跑失败 → 按迁移失败上报（false 可重试），状态仍为半迁移。
      if (existsSync(oldDb + MIGRATED_EXT) && existsSync(newDb)) {
        try {
          rewriteSessionKeys()
          log.warn('events', `事件库半迁移态自愈：旧库已搬而钥匙未改（${newDb}）——已幂等补跑钥匙 UPDATE`)
        } catch (e) {
          log.error('events', '事件库半迁移态钥匙补跑失败——按迁移失败上报可重试', e)
          return false
        }
      }
      return true
    }
    // 1) 断言旧库缓存无存活连接——有则放弃迁移（false，源库原地完整可重试）。
    //    R65-25（十三轮）：删除「refs=1 强制关库」死分支——close() 归零即置 closed 并
    //    从 openStores 删除（见上方 close 实现），Map 中未 closed 条目必 refs≥1，
    //    强关分支不可达；存活条目按 N8/R64-8 口径一律视为在途引用拦下。
    //    N8（五十九轮）：refs>0 = 有 openSessionStore 未 close 的使用方（在途对话/
    //    自愈/链路记录），此刻迁移会把它们的后续写入打到搬走的路径上。给可读错误
    //    并放弃迁移，让调用方先收口再迁。
    //    R64-8（十二轮）：判定从 refs>1 收紧为 refs>0——refs==1（首个在途调用方）
    //    同样是活跃持有者。
    const entry = openStores.get(oldDb)
    if (entry && !entry.closed) {
      log.error(
        'events',
        `事件库迁移中止：旧库仍有 ${entry.refs} 个在途引用（${oldDb}）——请先中止该书在途对话/自愈并释放连接后重试`,
      )
      return false
    }
    // 1.5) R67-2（十五轮）：跨进程「已持有句柄」探测——本进程引用清零不代表他进程也
    //    收口了（第二个进程/CLI 持旧库句柄，空闲态不持 SQLite 锁，checkpoint 拦不住）；
    //    扫描开口标记（死 pid 残留顺手 GC），有活标记即放弃迁移，源库原地完整可重试。
    //    标记登记在首开段同锁内完成——扫描与登记被目录锁互斥，无 TOCTOU。
    const liveMarkers = sweepOpenMarkers(dir, oldDb)
    if (liveMarkers.length > 0) {
      log.error(
        'events',
        `事件库迁移中止：旧库仍有他进程开口句柄（${liveMarkers.length} 个活标记，${oldDb}）——请先关闭持有该书的其他进程（第二个实例/CLI）后重试`,
      )
      return false
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
      // R0912-E-P3-3：close 纪律统一走 closeEventsDb（防裸 close 回流）——本 cp 未入
      // prepared 缓存，delete 为 no-op，行为不变
      closeEventsDb(cp)
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
    // 3.5) R71-25（十九轮）：墓碑前置到搬移之前——旧方案「COMMIT 后才落碑」在「钥匙
    //    已改 → 碑未落」间留有崩溃窗口：旧路径无 .db 也无 .migrated，迟来首开按正常
    //    缺库处理重建空库，旧 hash 下历史视图清零。前置后：搬移/改钥匙途中崩溃，旧
    //    路径至少有碑，openSessionStore 走墓碑分支 fail-closed 拒建空库；迁移重试
    //    （作者重试改名）到达时 existsSync(oldDb) 仍真（或碑已 GC）→ 重走全流程收口。
    //    碑 + 旧库并存对 openSessionStore 无影响（墓碑分支只在 .db 缺失时走）。目标位
    //    历史墓碑（书改回旧名再改回场景）一并清除——该路径重新成为活库位。预写失败 =
    //    一个文件都还没动 → 整体放弃（比 POST-COMMIT 失败不回滚的旧态更安全）。
    try {
      rmSync(newDb + MIGRATED_EXT, { force: true })
      // R41-11（四十一轮）：墓碑改原子写——裸 writeFileSync 写中途进程死会留半截 JSON，
      // 消费侧（firstOpenStore 墓碑分支）此前按「无指向」清除放行 → 迟来首开在旧路径
      // 重建空库、事件流分裂。原子写保证墓碑要么完整要么不在；消费侧对不可解析墓碑
      // 亦已改保留 + fail-closed（双防线）。
      atomicWriteFile(oldDb + MIGRATED_EXT, JSON.stringify({ to: newDb, at: Date.now() }))
    } catch (e) {
      log.error('events', `事件库迁移墓碑预写失败（${oldDb + MIGRATED_EXT}）——整体放弃，源库原地完整`, e)
      return false
    }
    for (const suffix of ['', '-wal', '-shm'] as const) {
      const from = oldDb + suffix
      const to = newDb + suffix
      if (existsSync(from)) {
        // R38-1（三十八轮）：收编 renameWithRetry——win 杀软/索引器瞬时锁（EPERM/EBUSY）
        // 下裸 renameSync 直接失败会触发回滚链；同一瞬时锁未释放时回滚 rename 同样失败，
        // 叠加下方「回滚失败仍撤墓碑」即拆掉 R71-25 防线（旧位 .db 与 .migrated 双缺 →
        // 迟来首开重建空库、事件流分裂）。3×50ms 退避让毫秒级瞬时占用在搬移段自愈。
        renameWithRetry(from, to)
        moves.push({ from, to })
      }
    }
    // 4) 在新库上改会话 book 字段（对话 + 工作区两把钥匙）。两条 UPDATE 同事务：
    //    中途失败随连接关闭整体回滚，不留「一把钥匙已改、一把没改」的半改状态；
    //    随后外层把文件搬移一并回滚——否则库在新位而钥匙是旧名，新旧两头都查不到。
    //    （实现抽 rewriteSessionKeys 闭包，与 R32-4 半迁移态自愈共用）
    rewriteSessionKeys()
    // 5) R71-25：墓碑已在 3.5) 前置落位——POST-COMMIT 无文件操作，原「COMMIT → 落碑」
    //    崩溃窗口（旧路径无 .db 无 .migrated → 迟来首开重建空库、事件视图分裂）就此
    //    闭合；R67-2 的墓碑语义（迟来首开 fail-closed 拒建空库）不变。
    return true
  } catch (e) {
    // 整体放弃：逆序把已搬文件搬回源位——源库原地完整、可读、可重试
    // R38-1（三十八轮）：回滚同样收编 renameWithRetry，且**回滚存在失败项时保留墓碑**——
    // 原实现回滚失败仅记日志、随后无条件 rmSync 撤碑：瞬时锁同时打断搬移与回滚时，
    // 旧位 .db 与 .migrated 双缺，迟来首开按「正常缺库」重建空库（R71-25 要防的事件流
    // 分裂就此发生）。碑 + 半回滚态并存只影响下次迁移重试的预写覆盖，不影响旧库打开
    // 判定面（墓碑分支只在 .db 缺失时走）——fail-closed 保留碑是安全侧。
    let rollbackFailed = false
    for (let i = moves.length - 1; i >= 0; i--) {
      const m = moves[i]!
      try {
        renameWithRetry(m.to, m.from)
      } catch (e2) {
        rollbackFailed = true
        // 回滚单文件失败属 OS 级异常（权限/磁盘满）：如实记日志供人工找回，
        // 不在回滚路径里再抛新异常掩盖原始失败原因
        log.error('events', `迁移回滚失败（${m.to} → ${m.from}），需人工找回`, e2)
      }
    }
    // R71-25：撤预写墓碑——回滚完成后旧位是完整活库，3.5) 前置的碑必须撤（残留碑 +
    // 活库并存对 openSessionStore 无功能影响——墓碑分支只在 .db 缺失时走——但会把
    // 下次迁移的墓碑预写变成覆盖旧值，语义漂移；best-effort + 留痕）。
    // R38-1：回滚存在失败项时**不撤碑**——旧位可能缺 .db，碑在才能让迟来首开走
    // fail-closed 分支拒建空库（数据在 newDb 成孤儿但不分裂）。
    if (!rollbackFailed) {
      try {
        rmSync(oldDb + MIGRATED_EXT, { force: true })
      } catch (e2) {
        log.error('events', `迁移回滚后墓碑清除失败（${oldDb + MIGRATED_EXT}）——残留碑不影响旧库打开，下次迁移时覆盖`, e2)
      }
    } else {
      log.error('events', `迁移回滚不完整，保留墓碑（${oldDb + MIGRATED_EXT}）——迟来首开将 fail-closed 拒建空库，请人工核对 ${oldDb} 与 ${newDb}`)
    }
    log.error('events', '事件库迁移失败（已回滚，源库原地完整可找回）', e)
    return false
  } finally {
    // R66-12：迁移段锁释放（成败路径都到——finally 必达）
    releaseMigrateLock()
  }
}

