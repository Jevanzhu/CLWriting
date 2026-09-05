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
import { DatabaseSync, type StatementSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import { mkdirSync, existsSync, readdirSync, readFileSync, rmSync, writeFileSync, statSync, utimesSync } from 'node:fs'
import { join, resolve, basename } from 'node:path'
import { ulid } from '../document/stable-id.js'
import type { ChatEvent, EventType, SurfaceOp } from './types.js'
import { SURFACE_EVENT_TYPES } from './types.js'
import { log } from '../log/index.js'
import { acquireCrossProcessLockWithTimeout, acquireCrossProcessLockAsync, isProcessAlive, processBootTime } from '../fs/cross-process-lock.js'
import { renameWithRetry, atomicWriteFile } from '../fs/atomic.js'

/** 书 hash：sha256(bookRoot) 前 16 hex——稳定，不落原文路径。
 *  B-18（第六十轮补修）：哈希前 resolve 归一化——尾分隔符 / '.'/'..' 段变体不再
 *  同书分裂两库（原先 sha256 原样入参，路径形态敏感）。存量安全：调用点路径源于
 *  books.json 单源的绝对无尾斜杠形态，resolve 对其恒等 → 存量库键不变、无孤儿化。
 *  R40-14（四十轮）：win32 上大小写漂移收口——书路径大小写漂移（盘符大小写/手工改名
 *  残留/注册时序不同）此前可开出第二个事件库文件（对话史/审计视图「丢史」假象）。
 *  归一手段是**逐段 readdirSync 大小写不敏感匹配盘上真名**（trueCasePath，memo 化）：
 *  初版用 fs.realpathSync，但 Node 在 win32 的 realpath 实测**不改写大小写**
 *  （返回入参形态，四十轮修复批当机复验），对漂移变体是无效修复——readdir 逐段匹配
 *  才拿得到盘上真实形态。正确大小写的存量路径逐段命中自身 → 键不变（不迁移）；
 *  漂移变体归一到真名后与正库同键合流。仅 win32 生效——mac/Linux 维持 B-18 既有
 *  口径（Linux 大小写变体是不同路径；mac 折叠语义与卷敏感性脱钩属 R40-23 登记，
 *  且 blanket 启用会重键存量库）。段消失/不可读（规划中的新建书等）→ 回落 resolve
 *  词法形态，语义同旧；UNC（\\\\server\\share）首层无盘符可依，同样回落。 */
export function bookHash(bookRoot: string): string {
  let root = resolve(bookRoot)
  if (process.platform === 'win32') {
    root = trueCasePath(root)
  }
  return createHash('sha256').update(root).digest('hex').slice(0, 16)
}

/** R40-14：win32 盘上真实大小写归一（逐段 readdir 匹配 + memo）。 */
const trueCaseCache = new Map<string, string>()
const TRUE_CASE_CACHE_MAX = 512

function trueCasePath(abs: string): string {
  const lower = abs.toLowerCase()
  const hit = trueCaseCache.get(lower)
  if (hit !== undefined) return hit
  const segs = abs.split(/[\\/]/).filter((s) => s !== '')
  let cur = ''
  let ok = true
  for (let i = 0; i < segs.length && ok; i++) {
    const seg = segs[i]!
    if (cur === '') {
      // 首段：盘符统一大写并带根（'c:' → 'C:\'，readdirSync('C:') 是驱动器相对路径
      // 不可用）；UNC 首段为主机名（'\\server\share\…' → '\\\\server'，可 readdir 列共享）
      cur = seg.endsWith(':') ? seg.toUpperCase() + '\\' : '\\\\' + seg
      continue
    }
    let next: string | null = null
    try {
      for (const entry of readdirSync(cur)) {
        if (entry.toLowerCase() === seg.toLowerCase()) {
          next = entry
          break
        }
      }
    } catch {
      ok = false
      break
    }
    if (next === null) {
      ok = false
      break
    }
    cur = cur.endsWith('\\') ? cur + next : `${cur}\\${next}`
  }
  if (!ok || cur === '') cur = abs // 段消失/不可读/空路径：回落词法形态（语义同旧）
  // FIFO 淘汰（书数量级小，上限为防御性口径，对齐库内缓存族惯例）
  if (trueCaseCache.size >= TRUE_CASE_CACHE_MAX) {
    const oldest = trueCaseCache.keys().next().value
    if (oldest !== undefined) trueCaseCache.delete(oldest)
  }
  trueCaseCache.set(lower, cur)
  return cur
}

export interface SessionRow {
  session_id: string
  format_version: number
  book: string
  header: string
  created_at: number
  updated_at: number
}

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
  /** R66-13（十四轮）：单事件便捷封装 = appendEvents(sid,[ev])[0]——生产链全走批接口
   *  （appendEvents / appendEventsResolveLineage），本方法零生产调用、仅测试使用
   *  （test/events/**、test/metrics/** 直接驱动）；待测试侧迁移批接口后随清理删除。 */
  appendEvent(sessionId: string, ev: NewEvent): number
  /** O-2（第十三轮）：可选 limit 限量通道（seq 升序取前 N）——现有调用方均为全量投影
   *  （折叠需要完整事件流，限流会破坏投影正确性，故不默认启用）；分页/审计渐进读取用。 */
  listEvents(book: string, sessionId?: string, limit?: number, type?: EventType): ChatEvent[]
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

// ── R46-42（四十六轮）：连接级 prepared 语句缓存 ─────────────────────────
// node:sqlite 的 StatementSync 与连接实例绑定，但 db.prepare 每次调用都重新编译同一
// 条 SQL——热路径（appendEvents 每批 2 条、listEvents 每读、workspaceSession 每链路
// 事件写）此前对固定 SQL 反复 prepare，纯白付编译开销。按 db 实例（WeakMap 键）+
// SQL 串双键缓存编译产物：连接 close 后缓存条目随 GC 消失，无悬挂执行面（重开库是
// 新实例、新缓存，天然隔离）。低频迁移/一次性语句（DDL、孤儿修复、钥匙改写、PRAGMA）
// 不走本帮手——缓存面只进恒定不变的高频 SQL。listEvents 的可选 type/limit 拼出的
// SQL 变体以 SQL 串本身为键，各自独立缓存（变体数有界）。
const preparedByDb = new WeakMap<DatabaseSync, Map<string, StatementSync>>()

/** R46-42：按 (db, sql) 取缓存的 prepared 语句；未见过则编译一次入缓存。 */
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

/** 孤儿会话补 end 的宽限期：最后活动距今不足该值视为「可能仍在进行」，不补（RB-IF-P2-2）。
 *  R65-19（十三轮）：宽限期对齐对话硬超时——AGENT_DEADLINE_MS = 30 分钟
 *  （src/ai/orchestrate/chat.ts，含嵌套 self-heal 的长对话最后活动后仍可能在跑），
 *  原 10 分钟会在对话进行中被跨进程误补 session/end {reason:'interrupted'}（审计流
 *  虚假中断 + 真实 session/end 后补双写）。取 32 分钟 = deadline + 2 分钟收尾余量；
 *  不 import 该常量（chat.ts 反向依赖本文件，提常量会成环），改由注释锚定对齐依据。 */
const ORPHAN_GRACE_MS = 32 * 60 * 1000

/** R66-12（十四轮）：session 目录级跨进程锁超时（毫秒）——迁移段与首开段互斥用，
 *  对齐 books.lock 的 5s（争用为文件 IO 级毫秒，极保守）。
 *  R26-105（二十六轮）：停止裸导出——`export let` 使模块态可被任何导入方静默改写，
 *  且「读侧直读 + 写侧 setter」两条通道并存。全仓 grep 生产与测试均无外部直读直写
 *  （仅本模块三处消费 + ForTest setter），收口为模块内 let + 仅供测试的 ForTest
 *  setter（同款惯例见 summary.ts R26-19 / lead-update-draft.ts R73-46）。 */
let SESSION_MIGRATE_LOCK_TIMEOUT_MS = 5_000

/** 测试注入钩子（生产零调用）。 */
export function __setSessionMigrateLockTimeoutForTest(ms: number): void {
  SESSION_MIGRATE_LOCK_TIMEOUT_MS = ms
}

/** R66-12：首开/迁移段跨进程锁（导出供回归测试模拟「另一进程持锁」；同进程嵌套获取
 *  同一锁会自锁——本模块持锁段对同一 bookHash 的锁互不嵌套）。
 *  R73-38（二十一轮）：锁名掺 bookHash——原先全局单把 migrate.lock 把所有书的首开段
 *  串成全局队头（多书库场景下开书 B 被无关书 A 的迁移/首开阻塞 5s 即失败）。改按书
 *  一把 `migrate-<bookHash>.lock`：开书/迁移只与**同一本书**（新旧路径两个 hash）互斥。
 *  迁移段须同持新旧两把（bookHash 排序获取防 ABBA 死锁）——openSessionStore(newRoot)
 *  与迁移 rename 窗口的互斥由此保持（Global 锁的唯一实质保护面），跨书并发不再互拽。 */
export function sessionMigrateLockPath(userDataPath: string, bookRoot: string): string {
  return join(userDataPath, 'clwriting', 'session', `migrate-${bookHash(bookRoot)}.lock`)
}

/** 迁移段按 bookHash 排序拿新旧两把锁；第二把拿不到 → 释放第一把返回 null（调用方按
 *  超时语义放弃迁移，源库原地完整）。排序获取保证任意迁移对之间无环路死锁。
 *  R34D-19（三十四轮）：锁等待异步化（acquireCrossProcessLockAsync，setTimeout 轮询）——
 *  改名端点（books.ts）在服务进程事件循环上调用 migrateBookSession，同步 Atomics.wait
 *  会在双进程争用窗内把事件循环停 2×5s；同步对版随之退役（唯一调用方已随迁）。 */
async function acquireMigrateLockPairAsync(
  userDataPath: string,
  oldRoot: string,
  newRoot: string,
): Promise<(() => void) | null> {
  const [first, second] =
    bookHash(oldRoot) <= bookHash(newRoot)
      ? [sessionMigrateLockPath(userDataPath, oldRoot), sessionMigrateLockPath(userDataPath, newRoot)]
      : [sessionMigrateLockPath(userDataPath, newRoot), sessionMigrateLockPath(userDataPath, oldRoot)]
  const releaseFirst = await acquireCrossProcessLockAsync(first, SESSION_MIGRATE_LOCK_TIMEOUT_MS)
  if (!releaseFirst) return null
  const releaseSecond = await acquireCrossProcessLockAsync(second, SESSION_MIGRATE_LOCK_TIMEOUT_MS)
  if (!releaseSecond) {
    releaseFirst()
    return null
  }
  return () => {
    releaseSecond()
    releaseFirst()
  }
}

// ── R67-2（十五轮）：跨进程「已持有句柄」标记 + 迁移墓碑 ──
// R66-12 的目录级锁只挡他进程**首开段**；迁移开始前就已打开的句柄（空闲态不持任何
// SQLite 锁，checkpoint busy=0 照样放行）成了残余窗口：rename 后他进程句柄的后续写入
// 打到已搬走的 inode，或下次重开旧路径时 DatabaseSync 重建空库——事件流就此分裂。
// 两个互补守卫：
// 1) 开口标记 <db>.open-<pid>：openSessionStore 首开登记（在目录锁内）、close() 归零
//    注销、进程崩溃残留由 pid 探测在扫描时 GC；migrateBookSession 持目录锁扫描——
//    有活标记即放弃迁移（false，源库原地完整可重试），把「先收口再迁」契约扩到跨进程。
// 2) 迁移墓碑 <db>.migrated：迁移成功后在旧位落指路标（内容 = 新库绝对路径）；
//    迁移完成后他进程才首开旧路径时，openSessionStore 据此 fail-closed 拒建空库
//    （走调用方既有 catch 降级 null），而不是开出第二只空库。墓碑指向的新库也已
//    不存在（再迁移/已删除）→ 墓碑过期，清掉放行新建（同路径重新建书场景）。

/** 句柄标记文件后缀（<dbPath>.open-<pid>）。 */
const OPEN_MARKER_SUFFIX = '.open-'
/** 迁移墓碑文件后缀（<dbPath>.migrated）。 */
const MIGRATED_EXT = '.migrated'

function openMarkerPath(dbPath: string): string {
  return dbPath + OPEN_MARKER_SUFFIX + process.pid
}

/** R71-24（十九轮）：开口标记续期周期——活句柄定期 utimes 刷标记 mtime，让「标记年龄」
 *  成为可靠的存活旁证（缺省 30s，测试可注入）。 */
let OPEN_MARKER_RENEW_MS = 30_000
/** R71-24（十九轮）：活 pid 但标记超龄的判死门槛（毫秒）——对齐 Z-19 锁超龄口径。
 *  正常活进程由续期定时器保持 mtime 恒新；超龄只可能是持有进程已死、pid 被系统复用
 *  给长命进程（跨进程 bootTime 无查询 API，年龄是可用判据）。残余风险如实记档：
 *  被长时间 SIGSTOP/深度 App Nap 挂起超门槛的活进程会被误判死——与 Z-19 对锁的
 *  同款取舍，门槛取保守的 10 分钟。 */
const OPEN_MARKER_STALE_MS = 10 * 60_000

/** 测试注入续期周期（生产勿调）。 */
export function configureOpenMarkerRenewMs(ms: number): void {
  OPEN_MARKER_RENEW_MS = ms
}

/** 扫描某库的全部开口标记：死 pid 残留与超龄残留顺手 GC（best-effort），返回活标记
 *  路径列表。只在持 session 目录锁的段内调用（登记/迁移互斥由锁保证）。
 *  R71-24：pid 存活但标记 mtime 超龄 → 视同死残留 GC——持有进程死后 pid 被复用时，
 *  单纯 pid 探测会永远误判活，该书迁移（改名）被无限期误拒。 */
function sweepOpenMarkers(dir: string, dbPath: string): string[] {
  const prefix = basename(dbPath) + OPEN_MARKER_SUFFIX
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return [] // 目录不存在：无任何标记
  }
  const live: string[] = []
  for (const name of names) {
    if (!name.startsWith(prefix)) continue
    const pid = Number.parseInt(name.slice(prefix.length), 10)
    if (Number.isInteger(pid) && pid > 0 && isProcessAlive(pid)) {
      // R71-24：活 pid + 超龄 mtime（续期早已停止）→ pid 复用残留，按死处理
      try {
        const age = Date.now() - Math.floor(statSync(join(dir, name)).mtimeMs)
        if (age <= OPEN_MARKER_STALE_MS) {
          live.push(join(dir, name))
          continue
        }
      } catch {
        // R72-6（二十轮 B-4）：stat 失败不再落删除路径——活 pid 的在位标记被 EACCES/
        // 竞态误 GC 会造成「迁移看不见我」的隐形句柄（registerOpenMarker fail-closed
        // 正是防它）。保守视为活：误判活的代价只是迁移被拒（安全方向），下次扫描再判
        live.push(join(dir, name))
        continue
      }
    }
    try {
      rmSync(join(dir, name), { force: true })
    } catch {
      /* GC 失败不阻断：下次扫描再试 */
    }
  }
  return live
}

/** 首开登记：GC 死残留 + 落本进程标记（fail-closed——登记失败时句柄不可信，抛错走
 *  调用方降级，不能带着「迁移看不见我」的隐形句柄继续写库）。
 *  R71-24：内容补 bootTime（诊断字段；同款语义见 cross-process-lock 锁文件）。 */
function registerOpenMarker(dir: string, dbPath: string): void {
  sweepOpenMarkers(dir, dbPath)
  writeFileSync(openMarkerPath(dbPath), JSON.stringify({ pid: process.pid, bootTime: processBootTime() }), 'utf-8')
}

/** R71-24：开口标记续期定时器的 tick——刷 mtime；标记文件被误 GC（他进程按超龄误判）
 *  时重写自愈（内容不变，重写即重新声明在位）。失败静默：下一 tick 再试。 */
function touchOpenMarker(dbPath: string): void {
  const p = openMarkerPath(dbPath)
  try {
    utimesSync(p, new Date(), new Date())
  } catch {
    try {
      writeFileSync(p, JSON.stringify({ pid: process.pid, bootTime: processBootTime() }), 'utf-8')
    } catch {
      /* best-effort：磁盘异常时静默，句柄仍由 pid 探测兜底 */
    }
  }
}

/** 归零注销（best-effort：文件系统异常时残留由下次扫描的 pid 探测 GC 收口）。 */
function releaseOpenMarker(dbPath: string): void {
  try {
    rmSync(openMarkerPath(dbPath), { force: true })
  } catch {
    /* best-effort */
  }
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
    if (o.starts > o.ends && !skip.has(o.session_id)) {
      // 新近活跃（可能是另一进程进行中的会话）或时间不可得 → 不补虚假 end
      if (o.last_at === null || now - o.last_at < ORPHAN_GRACE_MS) continue
      attempted++
      // N-5（第五十四轮）：INSERT（补 end）与 UPDATE（touch updated_at）两步同事务——
      // 此前裸跑两语句，中途失败留「补了 end 但 updated_at 未刷」半态。同
      // migrateBookSession 的 BEGIN/COMMIT + 失败回滚用法；事务内单会话两语句，
      // 失败回滚不影响已成功补齐的其他孤儿。
      // R31-22（三十一轮）：BEGIN 挪进 try——BEGIN IMMEDIATE 在 busy_timeout 耗尽时
      // 抛错，此前会冲出本循环经 maybeRepairOrphans（挂在 appendEvents/createSession
      // 头部）让无关的正常事件写入直接抛错；挪入后按单会话错误收集继续。
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
    SESSION_MIGRATE_LOCK_TIMEOUT_MS,
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
    SESSION_MIGRATE_LOCK_TIMEOUT_MS,
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
 *  漂移）；调用方须已持 session 迁移锁。
 *  WAL 切换退避（SQLITE_BUSY 重试）内的 Atomics.wait 微睡 ≤1.8s 有界保留：首开段
 *  已被迁移锁跨进程串行化，退避仅在他进程**已开库连接**持写锁的窗口触发，且
 *  DatabaseSync 的 DDL 序列是同步共用面不宜双轨化（收口记登记）。
 *  残留清偿批（三十四轮）复核维持：busy_timeout=5000 本身使 db.exec 在 SQLite
 *  内部同步等待——微睡异步化不消除真阻塞源（node:sqlite 无异步 API），双轨化只
 *  增 DDL 漂移面。此为本链同步残留登记中唯一的「不可异步化」架构项。 */
/** IR-2（独立重评 2026-09-02）：SQLite 库文件损坏类错误判据——node:sqlite 对
 *  SQLITE_NOTADB/CORRUPT 抛英文裸 message 且各版本措辞有差，按已知短语集匹配；
 *  宁可漏判走原样上抛，不误判把 BUSY/IOERR 包装成「损坏」。 */
function isDbCorruptionError(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e)
  return /file is not a database|database disk image is malformed|malformed database image|unsupported file format/i.test(
    msg,
  )
}

function firstOpenStore(bookRoot: string, dir: string, dbPath: string): SessionStore {
  let db: DatabaseSync
  // R71-24：开口标记续期定时器（首开成功后启动；打开期抛错保持 null）
  let markerTimer: ReturnType<typeof setInterval> | null = null
  try {
    // R67-2（十五轮）：旧路径库文件缺失 + 墓碑在位 = 该库曾随书改名迁走——分两态：
    // 旧书根目录已不存在（书确实改名迁走，stale 书目录视图的进程迟来首开）且墓碑
    // 指向的新库还活着 → fail-closed 抛错拒建空库（建空库会让事件流分裂成两半，走
    // 调用方既有 catch 降级 null）；旧根目录又在（同路径重新建书）或新库也已不存在
    // （再迁移/已删书）→ 墓碑过期，清除后放行正常新建。
    if (!existsSync(dbPath) && existsSync(dbPath + MIGRATED_EXT)) {
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
    mkdirSync(dir, { recursive: true })
    db = new DatabaseSync(dbPath)
    // 内存闸（2026-08-24 审计 B3）：打开期（PRAGMA/DDL/孤儿修复）抛错时句柄不滞留——
    // 此刻尚未登记 openStores，引用计数的 close 回收路径接不到它；调用方 catch 后降级
    // null 继续跑，句柄滞留进程积累（「损坏库重试」类测试反复触发尤甚）
    try {
      // N3（五十九轮）补：busy_timeout 必须先于 journal_mode=WAL 设置——WAL 切换在
      // journal_mode 处需拿写锁，若另一进程正持锁而 busy_timeout 未设，会立即抛
      // SQLITE_BUSY（N3 三进程并发首开回归在全量并发下偶发红的根因）
      db.exec('PRAGMA busy_timeout = 5000')
      // R73-48（二十一轮·裁定维持不加深退避）：审查项「8 次退避耗尽仍可抛 SQLITE_BUSY」
      // ——耗尽即抛是 fail-closed 正确出口，不是缺陷：每轮失败前 busy_timeout 已在
      // SQLite 内部等待 5s，8 轮 × 5s + 退避 1.8s ≈ 42s 仍抢不到，说明对手是僵死
      // 写方（SIGSTOP 挂起/磁盘级卡死），再等只会把「打开失败可重试」拖成分钟级假死；
      // 抛错走调用方既有 catch 降级 null，无数据损伤。维持 8 次 + 线性退避现状。
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
      // R67-2：首开成功（DDL/修复全过）→ 落开口标记（仍在目录锁内，与迁移扫描互斥）。
      // 放在 repair 之后：打开期抛错则不登记（句柄已在 catch 关闭）。
      registerOpenMarker(dir, dbPath)
      // R71-24：起续期定时器——活句柄定期刷标记 mtime；进程挂死/崩溃后停止续期，
      // 超龄标记在扫描时按 pid 复用残留 GC（见 sweepOpenMarkers）。unref 不阻退出。
      markerTimer = setInterval(() => touchOpenMarker(dbPath), OPEN_MARKER_RENEW_MS)
      markerTimer.unref()
    } catch (e) {
      try {
        db.close()
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
  } finally {
    /* R34D-19：锁释放归开库壳（同步壳/异步壳各自的 finally releaseOpenLock）——首开
       核心自身无锁可放；空 finally 仅保留外层 try 的既有嵌套层级，内层 try/catch
       负责「打开期抛错先关句柄」（2026-08-24 审计 B3 内存闸）。 */
  }
  // R66-12：登记/挂缓存段不碰库文件（纯内存），留在锁外——持锁面越小，迁移等待越短
  const entry: StoreEntry = { store: null!, refs: 1, closed: false, lastOrphanRepairAt: Date.now(), markerTimer }
  /** 写路径惰性孤儿修复（TTL = ORPHAN_GRACE_MS，至多每 32 分钟一次）：打开时仍在
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
      // R46-42：固定 SQL 走连接级 prepared 缓存（每会话一条，编译一次复用）
      prepared(
        db,
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
      // R46-42：每批热路径的固定 SQL 改 prepared 缓存（原每批重编译 INSERT+UPDATE 两条）
      const ins = prepared(
        db,
        `INSERT INTO events (session_id, turn, step, type, data, surface_op, shadow_start, shadow_end, source_seqs, replace_generation, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?) RETURNING seq`
      );
      const touch = prepared(db, 'UPDATE sessions SET updated_at = ? WHERE session_id = ?')
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
    // AA-P3-7：INSERT RETURNING 取真实 seq，sourceIdxs 批内索引同事务回写解析——
    // 血缘不再依赖 lastSeq()+批内序号推算（多窗口并发写事件库时可能错链到别窗的 seq）
    appendEventsResolveLineage(sessionId: string, evs: NewEvent[]): number[] {
      maybeRepairOrphans()
      const now = Date.now()
      // R46-42：同 appendEvents——三条固定 SQL 改 prepared 缓存
      const ins = prepared(
        db,
        `INSERT INTO events (session_id, turn, step, type, data, surface_op, shadow_start, shadow_end, source_seqs, replace_generation, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, 0, ?) RETURNING seq`
      )
      const upd = prepared(db, 'UPDATE events SET source_seqs = ? WHERE session_id = ? AND seq = ?')
      const touch = prepared(db, 'UPDATE sessions SET updated_at = ? WHERE session_id = ?')
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
      // R65-20（十三轮）：坏行降级——单行 data/source_seqs JSON 损坏时 rowToEvent 抛错
      // 直穿会炸整个 listEvents（chat 恢复/audit/历史端点整体 500）；逐行 try/catch
      // 跳过坏行 + warn 留行 seq 与病因（log.warn 未 init 时即镜像 console.warn），
      // 好行完整返回
      const safeRowToEvent = (r: Row): ChatEvent | null => {
        try {
          return rowToEvent(r)
        } catch (e) {
          log.warn('events', `listEvents 跳过坏行 seq=${r.seq}（${e instanceof Error ? e.message : String(e)}）`)
          return null
        }
      }
      if (sessionId) {
        const args: Array<string | number> = [sessionId]
        if (type !== undefined) args.push(type)
        if (cap !== undefined) args.push(cap)
        // R46-42：读热路径固定/有界变体 SQL 走 prepared 缓存（变体以 SQL 串为键独立缓存）
        const rows = prepared(
          db,
          `SELECT * FROM events WHERE session_id = ? ${type !== undefined ? 'AND type = ?' : ''} ORDER BY seq ASC ${cap !== undefined ? 'LIMIT ?' : ''}`
        ).iterate(...args) as unknown as Iterable<Row>
        for (const r of rows) {
          const ev = safeRowToEvent(r)
          if (ev) out.push(ev)
        }
        return out
      }
      const args: Array<string | number> = [book]
      if (type !== undefined) args.push(type)
      if (cap !== undefined) args.push(cap)
      const rows = prepared(
        db,
        `SELECT * FROM events
         WHERE session_id IN (SELECT session_id FROM sessions WHERE book = ?) ${type !== undefined ? 'AND type = ?' : ''}
         ORDER BY seq ASC ${cap !== undefined ? 'LIMIT ?' : ''}`
      ).iterate(...args) as unknown as Iterable<Row>
      for (const r of rows) {
        const ev = safeRowToEvent(r)
        if (ev) out.push(ev)
      }
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
      const stmt = db.prepare(
        `SELECT * FROM sessions WHERE book = ? AND session_id NOT LIKE 'ws-%' ORDER BY updated_at DESC, rowid DESC LIMIT 1`
      );
      const r = stmt.get(book) as SessionRow | undefined
      return r ?? null
    },
    lastSeq(): number {
      // R46-42：recorder 写前算区间的固定查询走 prepared 缓存
      const row = prepared(db, 'SELECT MAX(seq) AS m FROM events').get() as { m: number | null }
      return row.m ?? 0
    },
    maskSelfCheckData(from: number, to: number) {
      // R66-16（十四轮）：close 写 compaction 前的遮蔽区间自检数据源——O(1) 索引查询，
      // 不做投影全量重放（validateEventStream 的生产接线最小面）。区间重叠判定：
      // 既有 [s,e] 与 [from,to] 相交 ⟺ s <= to && e >= from
      const intervals = (
        db
          .prepare(
            `SELECT shadow_start AS start, shadow_end AS end FROM events
             WHERE surface_op = 'replace' AND shadow_start IS NOT NULL AND shadow_end IS NOT NULL
               AND shadow_start <= ? AND shadow_end >= ?`,
          )
          .all(to, from) as Array<{ start: number; end: number }>
      ).map((r) => ({ start: r.start, end: r.end }))
      const surfaceTypes = [...SURFACE_EVENT_TYPES]
      const ph = surfaceTypes.map(() => '?').join(',')
      const rows = db
        .prepare(`SELECT seq, type, data FROM events WHERE seq >= ? AND seq <= ? AND type IN (${ph}) ORDER BY seq`)
        .all(from, to, ...surfaceTypes) as Array<{ seq: number; type: string; data: string }>
      return { intervals, rows }
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
          db.close()
        } catch (e) {
          // close 失败只留痕：停表/注销已正确收口，句柄由进程退出兜底回收
          log.warn('events', `事件库关闭异常（${dbPath}）：${e instanceof Error ? e.message : String(e)}`)
        }
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
    log.warn('events', `事件库迁移锁获取失败（${e instanceof Error ? e.message : String(e)}）——放弃本轮，源库原地完整可重试`)
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
      db.prepare('UPDATE sessions SET book = ? WHERE book = ?').run(newName, oldName)
      db.prepare('UPDATE sessions SET book = ? WHERE book = ?').run(bookHash(newRoot), bookHash(oldRoot))
      db.exec('COMMIT')
    } finally {
      // 未 COMMIT 的事务随连接关闭回滚（先关干净再让异常冒泡去回滚文件搬移）
      db.close()
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

