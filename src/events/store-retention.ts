/**
 * 会话库保留策略与空间回收（events 域维护族）。
 *
 * 两件事：
 * ① 观测类家族的保留窗口（pruneExpiredObservationEvents）——只裁「零读取方」的家族，
 *    把逐章重复产生的重试/机检明细压成有界窗口；
 * ② 已释放页与 WAL 的空间回收（reclaimFreedSpace）——DELETE 只把页放进空闲表，文件
 *    高水位不回落；清库与关闭时须显式回收，否则库文件单向膨胀。
 *
 * **可裁剪家族的判据**（逐个核过读取方，勿随手加白名单成员）：
 * - 白名单三族（PRUNABLE_EVENT_TYPES）在 src/ 全库零读取方，只有生产者：llm/retry 与
 *   retry/attempt 是重试记账（runner 退避、self-heal 打回），check/report 是自愈每轮
 *   机检报告——都是逐章重复产生的观测明细，不是任何读侧的输入。
 * - 禁删族的排除理由（各有硬约束，动它们即破坏语义）：
 *   · user/message、assistant/message、tool/result = surface 三类，投影（foldSurface/
 *     deriveMessages）、对话恢复（loadHistoryWithSeqs）、审计视图、前端种子化全靠它们
 *     重建——裁剪等于删对话正文；
 *   · compaction/start、compaction/end 是遮蔽区间载体，删一行就让被压内容在投影里复活；
 *   · session/start、session/end 是孤儿修复的配对计数依据（starts > ends 才补 end），
 *     删掉会被重新判成孤儿、补出虚假 session/end；
 *   · llm/call 是成本/轨迹聚合的唯一真源（cost-stats、trace-stats、令牌校准全量重扫）；
 *   · tool/call 是工具调用与结果的关联凭据，并被审计事件列表逐条展示（契约即「审计用」）；
 *   · check/false-positive 有生产读取方（机检端重放取「同章同 checkId 最近一条」）；
 *   · goal/change、todo/write 由审计折叠当前态（foldGoals/foldTodos）；
 *   · structure.merge 系列是撤销合并的定位凭据（重放找「最近一条未被 undo 的 merge」）；
 *   · revision/ref、settings/snapshot、skills/snapshot 是「模型可见 ⟺ 已记录」血缘登记；
 *   · chat_gap、chat/sanitize 是断链与发送前消毒的唯一痕迹（丢事件必留痕的凭据）；
 *   · turn/*、step/* 是审计工作流视图的骨架行。
 * - 白名单为何删得安全：遮蔽区间只覆盖录制期 surface 白名单且 seq 连续的段
 *   （chat-bridge 按 surfaceSeqs 归并连续段），白名单家族既非 surface 也不进遮蔽位，
 *   删行落不进任何遮蔽区间；万一被外力改坏，关闭路径的在线自检（store-selfcheck）留痕。
 *
 * **阈值依据**：保留窗口默认 30 天——进程日志的 7 天轮转是运维数据口径，观测事件要做
 * 跨章复盘与费用核对，30 天覆盖近期复盘需求，同时把「每章多次重试 + 每轮机检」的无界
 * 累积压成有界窗口。
 *
 * **执行时机**：只挂既有生命周期（clearBook/clearBooks 的清库路径、会话库引用归零的关闭
 * 路径、删书），不新增周期定时器；调度用一次 setImmediate，任务持自开连接并在块间让出事件
 * 循环——真干活的那一次不在调用方（服务进程事件循环）上执行整库重写。
 * 机会档的开工判据由调用方在**已开的连接**上现读（header/索引级廉价读）：无活连 setImmediate
 * 都不排，常态零开销；判据与干活共用连接形态的另一条硬约束是「只读连接不得用来探路」——
 * 在 WAL 库上开只读连接会落下 `-wal`/`-shm` 侧车且关连接不回收（读方无权删），而库文件
 * 指纹正是 stats 端点结果缓存的失效判据（见 studio/server/api/stats-signature），旁路动作
 * 若扰动侧车就会把端点缓存整片打冷（实测：一次探针 = 缓存失配重算）。
 *
 * **与其他生命周期段的互斥**（不自造锁，用既有那把）：写阶段持 session 迁移锁
 * （sessionMigrateLockPathForDb，按库名反推同一把），与首开/迁移段互斥；拿不到即本轮跳过
 * （维护是让利动作，不抢锁）。先关库再放锁，迁移的 rename 不会打断维护写入。
 *
 * **依赖方向单向（无环回引）**：只 import node:sqlite / node:fs / node:path、../log、
 * ../async、../fs 与 ../shared；store.ts 取本文件的维护族，本文件不 import store.ts。
 */
import { DatabaseSync } from 'node:sqlite'
import { existsSync } from 'node:fs'
import { log, errMsg } from '../log/index.js'
import { yieldToEventLoop } from '../async.js'
import { closeWithPrepared, rollbackQuietly } from '../shared/sqlite-prepared.js'
import { testableConst } from '../shared/testable.js'
import { acquireCrossProcessLockAsync } from '../fs/cross-process-lock.js'
import {
  RELEASE_MIN_FREE_PAGES,
  pageStats,
  reclaimFreedSpace,
  withShortBusyTimeout,
  type ReclaimOutcome,
} from '../fs/sqlite-vacuum.js'
import { sessionMigrateLockPathForDb } from './store-migrate.js'

/** 可裁剪事件族（观测类、零读取方；判据见文件头）。新增成员必须先核读取方与遮蔽安全性。 */
export const PRUNABLE_EVENT_TYPES = ['llm/retry', 'retry/attempt', 'check/report'] as const

/** 保留窗口（毫秒）：窗口内的白名单族一律不删；默认 30 天（依据见文件头）。 */
export const [getEventRetentionMs, __setEventRetentionMsForTest] = testableConst(30 * 24 * 60 * 60 * 1000)

/** 单轮裁剪的取行窗口（seq 升序每窗最多这些行）：窗口有界，避免整表进内存。 */
export const PRUNE_WINDOW_ROWS = 512
/** 单轮裁剪最多推进的窗口数：单次维护的扫描量封顶于此，余量留给下轮（游标续读）。 */
export const PRUNE_MAX_WINDOWS = 4
/** 裁剪的最小间隔（按库路径）：到期行裁净后仍会有「尚在保留期的首行」残留判据，本闸把
 *  「每次关闭都开一个写事务」压成「至多每 6 小时一次」；测试注入 0 可逐轮跑。 */
export const [getPruneMinIntervalMs, __setPruneMinIntervalMsForTest] = testableConst(6 * 60 * 60 * 1000)
/** 迁移锁的等待档：拿不到即本轮跳过（不排队等首开/迁移段让路）。 */
const MAINTENANCE_LOCK_TIMEOUT_MS = 150
/** 游标/时刻表上限（FIFO）：条目只是一个整数，上限纯防御。 */
const TABLE_MAX = 256

/** 事件库体积观测阈值（行数）——**只读观测**：超阈只 warn 留痕，不改任何保留语义
 *  （产品数据依旧只能由作者点「清空对话 / 清除事件史 / 删书」回收）。行数以 MAX(seq)
 *  近似（seq 是 INTEGER PRIMARY KEY 且单调递增，清库后重置）：O(log n) 索引探测，
 *  不为观测在维护路径上扫全表。 */
export const [getEventStoreRowWarnThreshold, __setEventStoreRowWarnThresholdForTest] = testableConst(200_000)
/** 事件库体积观测阈值（主库页数 × 页大小）——与行数阈同款处理。 */
export const [getEventStoreBytesWarnThreshold, __setEventStoreBytesWarnThresholdForTest] = testableConst(
  1024 * 1024 * 1024,
)
/** 观测留痕的按库节流（同一库路径只 warn 一次；条目为时刻，FIFO 上限纯防御）。 */
const footprintWarnedAt = new Map<string, number>()

export interface EventStoreFootprint {
  /** 行数近似上界（MAX(seq)）；-1 = 读失败（按未超阈处理） */
  rows: number
  /** 主库字节数（页数 × 页大小）；-1 = 读失败 */
  bytes: number
}

/**
 * 只读观测：库体积/行数读数 + 超阈 warn 留痕（每库至多一次；不改数据、不触发裁剪或
 * 回收）。调用方须持**已开**连接——不为观测另开连接（只读连接在 WAL 库上留不回收的
 * 侧车，且库指纹是 stats 端点缓存的失效判据，见文件头）。读失败按未超阈处理：观测面
 * 不得反噬维护链。
 */
export function observeEventStoreSize(db: DatabaseSync, dbPath: string): EventStoreFootprint {
  let rows = -1
  try {
    rows = (db.prepare('SELECT COALESCE(MAX(seq), 0) AS m FROM events').get() as { m?: number } | undefined)?.m ?? -1
  } catch {
    /* 表不在位/库不可读：按未超阈处理 */
  }
  const pages = pageStats(db).pages
  const pageSize = (db.prepare('PRAGMA page_size').get() as { page_size?: number } | undefined)?.page_size ?? 4096
  const bytes = pages < 0 ? -1 : pages * pageSize
  const overRows = rows >= 0 && rows >= getEventStoreRowWarnThreshold()
  const overBytes = bytes >= 0 && bytes >= getEventStoreBytesWarnThreshold()
  if ((overRows || overBytes) && !footprintWarnedAt.has(dbPath)) {
    remember(footprintWarnedAt, dbPath, Date.now())
    log.warn(
      'events',
      `事件库体积/行数超阈（行数 ≈ ${rows}，主库 ${bytes} 字节）——产品数据不自动裁剪，请按需清空对话/清除事件史：${dbPath}`,
    )
  }
  return { rows, bytes }
}

export interface PruneOutcome {
  /** 本轮实际取行条数（受窗口上限约束，非全表行数） */
  scanned: number
  /** 本轮删除条数——重复执行恒为 0（无到期行可删即无副作用） */
  deleted: number
  /** true = 本轮跑满窗口上限（旧区段可能还有余量，下轮续读）；false = 已到保留区起点 */
  truncated: boolean
}

/** 维护触发档：'idle' = 关闭路径的机会档（到期/超阈才动手）；'force' = 清库路径的
 *  强制档（刚删完行，回收端有空闲页就收）。 */
export type MaintenanceTrigger = 'idle' | 'force'

export interface MaintenanceOutcome {
  /** null = 本轮未跑裁剪（未到期或被间隔闸拦下） */
  pruned: PruneOutcome | null
  /** null = 本轮未跑回收（空闲页不足） */
  reclaimed: ReclaimOutcome | null
}

/** 裁剪游标（按库路径记「已归类到哪条 seq」，免下轮重扫已归类的旧区段）。键是库路径而非
 *  书键（不进书键缓存登记制）；条目为单个整数，FIFO 上限纯防御。 */
const pruneCursors = new Map<string, number>()
/** 上次真跑了裁剪的时刻（按库路径） */
const lastPruneAt = new Map<string, number>()
/** 在途维护（按库路径 → 同一轮任务的 promise）：重复调度复用在途任务而非叠起第二个连接，
 *  这也是「调度版 + await 版混调」时结果确定的前提。 */
const inFlight = new Map<string, Promise<MaintenanceOutcome | null>>()

function remember(map: Map<string, number>, key: string, value: number): void {
  if (!map.has(key) && map.size >= TABLE_MAX) {
    const oldest = map.keys().next().value
    if (oldest !== undefined) map.delete(oldest)
  }
  map.set(key, value)
}

/** busy 类冲突（另一连接持锁/写）——维护面把「争用」与「故障」分流：争用静默跳过，
 *  故障才留痕。判据是 node:sqlite 抛出的英文 message（各版本措辞一致短语）。 */
function isBusyError(e: unknown): boolean {
  const msg = errMsg(e)
  return /SQLITE_BUSY|database is locked|database table is locked/i.test(msg)
}

/** 库内是否已有 events 表：幽灵库（他进程刚建文件未跑 DDL）与空库在此静默跳过。 */
function hasEventsTable(db: DatabaseSync): boolean {
  const r = db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'events'").get() as
    { n?: number } | undefined
  return (r?.n ?? 0) > 0
}

/** 到期闸：最旧一行的时间戳（seq 是主键，取首行是索引探测不扫全表）早于保留窗口才算到期。 */
export function isPruneDue(db: DatabaseSync, now: number = Date.now()): boolean {
  const oldest = db.prepare('SELECT created_at FROM events ORDER BY seq ASC LIMIT 1').get() as
    { created_at: number } | undefined
  return oldest !== undefined && oldest.created_at < now - getEventRetentionMs()
}

/** 机会档开工判据（廉价档：一次索引探测 + 一次 header 读，无全表扫）：到期可裁，或空闲页
 *  已到回收阈值。两读都在调用方已开的连接上做——不为「探路」另开连接（只读连接会在 WAL
 *  库上留下不回收的侧车，见文件头）。判据为假 = 本轮什么都不用做。 */
export function isIdleMaintenanceDue(db: DatabaseSync, now: number = Date.now()): boolean {
  return isPruneDue(db, now) || pageStats(db).free >= RELEASE_MIN_FREE_PAGES
}

/** 清库路径的游标作废：游标记的是「已归类的旧区段到此为止」，清库把那些行整段删掉后
 *  这个边界不再代表任何事实，且 seq 会从 1 重新分配（events.seq 无 AUTOINCREMENT）——留着
 *  旧游标会让清库后新落库的行全部落在游标之前，永久不被裁剪。清库方（clearBook/clearBooks）
 *  在调度维护前调本函数。 */
export function resetPruneCursor(dbPath: string): void {
  pruneCursors.delete(dbPath)
  lastPruneAt.delete(dbPath)
}

/**
 * 按保留窗口裁剪观测类家族（白名单见 PRUNABLE_EVENT_TYPES），返回本轮扫描/删除条数。
 *
 * 成本纪律：① 取行有界——seq 升序窗口 + 窗口数上限，单轮最多扫
 * PRUNE_WINDOW_ROWS × PRUNE_MAX_WINDOWS 行；② 游标续读——已归类的旧区段记在
 * pruneCursors，下轮从该 seq 起；③ 族判定在内存做（窗口行已在手，不按族多次查库）；
 * ④ 一个 BEGIN IMMEDIATE 包住全部删除（要么整轮生效要么全不动）——用 IMMEDIATE 而非
 * deferred：deferred 的读→写升级在并发写方存在时会直接 SQLITE_BUSY，不按等待档重试。
 *
 * 幂等：无到期行时 deleted=0 且不动库（游标是内存态），重复执行零副作用。
 * 单轮跑满窗口上限时 truncated=true，由驱动方决定是否续下一轮。
 * 游标越界自愈：events.seq 是 INTEGER PRIMARY KEY（无 AUTOINCREMENT），清库把行删空后
 * 主键从 1 重新分配，而游标是进程内存态不会跟着回退——清库路径因此显式调 resetPruneCursor
 * （见该函数注：游标所指的旧区段随清库消失，留着它会让该书的新行永久落在游标之前、再也不裁）；
 * 本函数另按 MAX(seq) 夹一次游标，兜住「库文件被删后重建」这类清库路径之外的形态。
 */
export function pruneExpiredObservationEvents(
  db: DatabaseSync,
  dbPath: string,
  now: number = Date.now(),
): PruneOutcome {
  const cutoff = now - getEventRetentionMs()
  return withShortBusyTimeout(db, () => {
    const window = db.prepare('SELECT seq, type, created_at FROM events WHERE seq > ? ORDER BY seq ASC LIMIT ?')
    const del = db.prepare('DELETE FROM events WHERE seq = ?')
    const maxSeq =
      (db.prepare('SELECT COALESCE(MAX(seq), 0) AS m FROM events').get() as { m?: number } | undefined)?.m ?? 0
    let cursor = pruneCursors.get(dbPath) ?? 0
    if (cursor > maxSeq) cursor = 0
    let scanned = 0
    let deleted = 0
    let truncated = true
    db.exec('BEGIN IMMEDIATE')
    try {
      windowLoop: for (let win = 0; win < PRUNE_MAX_WINDOWS; win++) {
        const rows = window.all(cursor, PRUNE_WINDOW_ROWS) as Array<{ seq: number; type: string; created_at: number }>
        if (rows.length === 0) {
          truncated = false
          break
        }
        scanned += rows.length
        for (const r of rows) {
          cursor = r.seq
          // 首个仍在保留期内的行 = 旧区段结束（seq 升序 ≈ 时间序）——就此收束，游标停在
          // 该行，下轮从它续读（时间戳被外力回拨的异常行不追删：保守不越界）
          if (r.created_at >= cutoff) {
            truncated = false
            break windowLoop
          }
          if ((PRUNABLE_EVENT_TYPES as readonly string[]).includes(r.type)) {
            del.run(r.seq)
            deleted++
          }
        }
      }
      db.exec('COMMIT')
    } catch (e) {
      rollbackQuietly(db)
      throw e
    }
    remember(pruneCursors, dbPath, cursor)
    return { scanned, deleted, truncated }
  })
}

/** 空间回收的实现单源在 `fs/sqlite-vacuum`（events / rag / cache / check / learn 五库共用）：
 *  档位判定、折 WAL、逐块释放与整库重写的存活页上限都在那边，本模块只负责「什么时候收」
 *  （让利档 vs 强制档）与库级节流/互斥。 */
export {
  reclaimFreedSpace,
  readAutoVacuumMode,
  pageStats,
  truncateWal,
  AUTO_VACUUM_NONE,
  type ReclaimOutcome,
} from '../fs/sqlite-vacuum.js'

/**
 * 一轮维护（裁剪 + 回收）：写阶段持迁移锁，与首开/迁移互斥；先关库再放锁由调用方保证
 * （见 maintainDbPath 的 finally 顺序）。让出点：裁剪续轮之间、回收块之间。
 */
async function runMaintenance(
  db: DatabaseSync,
  dbPath: string,
  now: number,
  trigger: MaintenanceTrigger,
): Promise<MaintenanceOutcome> {
  const isStopped = (): boolean => !existsSync(dbPath)
  let pruned: PruneOutcome | null = null
  const lastAt = lastPruneAt.get(dbPath)
  if (isPruneDue(db, now) && (lastAt === undefined || now - lastAt >= getPruneMinIntervalMs())) {
    remember(lastPruneAt, dbPath, now)
    pruned = { scanned: 0, deleted: 0, truncated: false }
    for (;;) {
      const roundOut = pruneExpiredObservationEvents(db, dbPath, now)
      pruned.scanned += roundOut.scanned
      pruned.deleted += roundOut.deleted
      pruned.truncated = roundOut.truncated
      if (!roundOut.truncated || isStopped()) break
      await yieldToEventLoop()
    }
  }
  let reclaimed: ReclaimOutcome | null = null
  if (!isStopped()) reclaimed = await reclaimFreedSpace(db, trigger === 'force')
  return { pruned, reclaimed }
}

/** 库路径上跑一轮维护（独立连接，写阶段持迁移锁）。 */
async function maintainDbPath(dbPath: string, trigger: MaintenanceTrigger): Promise<MaintenanceOutcome | null> {
  const running = inFlight.get(dbPath)
  if (running !== undefined) {
    // 在途任务复用在同档（避免同一库叠起两个连接）；强制档（清库路径）等它收尾后补跑一轮
    // ——不补跑会让「清完即回收」被恰在关闭路径起的那一轮机会档任务吞掉
    await running
    if (trigger === 'idle') return null
  }
  const task = (async (): Promise<MaintenanceOutcome | null> => {
    if (!existsSync(dbPath)) return null
    // 与首开/迁移段互斥（同一把 session 迁移锁）；拿不到即本轮跳过，不排队
    const releaseLock = await acquireCrossProcessLockAsync(
      sessionMigrateLockPathForDb(dbPath),
      MAINTENANCE_LOCK_TIMEOUT_MS,
    )
    if (!releaseLock) return null
    let db: DatabaseSync | null = null
    try {
      // 取锁那一步会 await（让出事件循环），其间库文件可能被删（删书路径清完行即删库）
      // ——开写连接前复查一次：DatabaseSync 打开不存在的路径会**新建**空文件，跳过即可不留孤儿
      if (!existsSync(dbPath)) return null
      db = new DatabaseSync(dbPath)
      // 开工前的现势复查（判据同 isIdleMaintenanceDue，此处用自开连接）：调度与开工之间库
      // 可能已被清表/清空（清库路径的强制档不吃这道闸——清完即回收正是它的目的）。
      // 幽灵库（他进程刚建文件未跑 DDL）与空库也在复查里静默跳过。
      if (!hasEventsTable(db)) return null
      // 体积/行数只读观测先跑（与到期/空闲页判据无关）：库只增不减时这是唯一的可见面，
      // 超阈当场 warn 留痕；观测不裁剪、不回收，保留语义零变化
      observeEventStoreSize(db, dbPath)
      if (trigger === 'idle' && !isIdleMaintenanceDue(db)) return null
      return await runMaintenance(db, dbPath, Date.now(), trigger)
    } finally {
      // 顺序不得倒置：先关库再放锁——反序会让迁移段在库仍被本连接持有（且可能正在写）时
      // 搬走文件
      if (db !== null) {
        try {
          closeWithPrepared(db)
        } catch (e) {
          log.warn('events', `事件库维护连接关闭异常（${dbPath}）：${errMsg(e)}`)
        }
      }
      releaseLock()
    }
  })().catch((e) => {
    // 争用（另一连接持锁）是维护的常态出口，静默；真故障才留痕
    if (!isBusyError(e)) {
      log.warn('events', `事件库后台维护降级（库=${dbPath}）：${errMsg(e)}——余量待下个维护点收敛`)
    }
    return null
  })
  inFlight.set(dbPath, task)
  try {
    return await task
  } finally {
    if (inFlight.get(dbPath) === task) inFlight.delete(dbPath)
  }
}

/**
 * 后台维护调度（一次 setImmediate，非周期定时器）：清库路径与会话库关闭路径共用入口，把
 * 「清空对话 / 清除事件史后要回收空间」「库龄到期要裁保留窗口」收敛到同一任务上。
 * 调用方不 await、不承担耗时——真干活的是自开连接。
 * 触发档（trigger）：'idle' = 关闭路径的机会档（到期/超阈才动手）；'force' = 清库路径的
 * 强制档（刚删完行，回收端有空闲页就收——清库要的就是空间回落，不受阈值拦）。
 * 失败只留痕（一次后台维护失败不该打断任何业务路径）；库不在位静默跳过（删书、测试收尾）。
 * 注意：库文件可能在任务开始后被外部删除（删书路径先清库再删文件）——入队时、取锁后开写连接前
 * 各查一次在位（DatabaseSync 打开不存在的路径会新建空文件，不查就会留一个空壳孤儿）；两次复查
 * 之间的窗口无 await，实际收口到「查在位与 open 之间的微秒级窗口」——真撞上也只留一个 0 字节
 * 空文件，下次首开按空库重建，不损任何数据（本任务从不删行以外的数据）。
 */
export function scheduleSessionDbMaintenance(dbPath: string, trigger: MaintenanceTrigger = 'idle'): void {
  setImmediate(() => {
    void maintainDbPath(dbPath, trigger)
  })
}

/** 可 await 的维护入口（确定性测试与需要「回收完再继续」的调用方用；与调度版同一任务表，
 *  并发调用复用在途任务而不是叠第二个连接）。 */
export function runSessionDbMaintenanceAsync(
  dbPath: string,
  trigger: MaintenanceTrigger = 'idle',
): Promise<MaintenanceOutcome | null> {
  return maintainDbPath(dbPath, trigger)
}
