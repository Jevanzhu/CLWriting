/**
 * SQLite 空间回收单源：auto_vacuum 档位判定 + 「折 WAL → 按档位回收」的完整路径。
 *
 * 为什么要在 `fs` 层：DELETE 只把页放进空闲表，主库文件的高水位不会回落——「删了很多行
 * 但文件还是那么大」是每个自带 sqlite 的模块都会遇到的同一个问题。本仓有五个库
 * （events / rag / cache / check / learn），此前只有 events 有回收路径，其余四个文件只会
 * 长不会缩。抽在这里而不是 events 里，是为了让四库都能引而不反向依赖 events。
 *
 * 两条路径按库自身的 auto_vacuum 档分流：
 * - 已是增量模式（1/2）：逐块 incremental_vacuum 释放空闲页，单轮有页预算（超预算的余量
 *   留给后续维护点收敛），不整库重写；**块与块之间让出事件循环**。
 * - 仍是 0（存量库）：auto_vacuum 只有「同一连接上先设 PRAGMA 再立即 VACUUM」这一条转换
 *   路径（单独设 PRAGMA 不落库，也不会靠之后某次 VACUUM 生效——实测如此），故此处承担
 *   转换：仅当空闲页 ≥ CONVERT_MIN_FREE_PAGES 且存活页 ≤ CONVERT_VACUUM_LIVE_PAGE_MAX
 *   才做。VACUUM 内部是单段同步执行（SQLite 无异步入口），故代价靠**存活页上限**封顶：
 *   实测约 13µs/存活页，2048 页 ≈ 30ms。**这个上限是接入任何库的前提**——没有它，一个大库
 *   的 VACUUM 会把事件循环独占若干秒。
 *
 * 单段同步执行这点不可绕过，故本模块只提供「有界回收」，不提供「想收就收干净」。
 */

import type { DatabaseSync } from 'node:sqlite'
import { yieldToEventLoop } from '../async.js'

/** SQLite auto_vacuum 档位（PRAGMA 读回值，库 header 位域）：0=未定档 1=整库 2=增量。
 *  档位判定单源——打开期（决定是否下 auto_vacuum 语句）与回收路径分流同取本值。 */
export const AUTO_VACUUM_NONE = 0
export const AUTO_VACUUM_INCREMENTAL = 2

/** 现读库的 auto_vacuum 档（header 读，廉价；读不到按 0 = 未定档处理）。 */
export function readAutoVacuumMode(db: DatabaseSync): number {
  return (db.prepare('PRAGMA auto_vacuum').get() as { auto_vacuum?: number } | undefined)?.auto_vacuum ?? 0
}

/** 空间回收的最小空闲页数：低于此不值当一次 checkpoint + 回收（避免每次维护都动 WAL）。 */
export const RELEASE_MIN_FREE_PAGES = 64
/** 每次 incremental_vacuum 的块大小：单块有界（毫秒级），让出点在块与块之间。 */
export const INCREMENTAL_VACUUM_CHUNK_PAGES = 64
/** 单轮回收的空闲页预算：整轮合计（实测 ~10µs/页，4096 页约 40ms 上限），余量留给后续维护点。 */
export const INCREMENTAL_VACUUM_MAX_PAGES = 4096
/** 转增量模式的最小空闲页：少于此不值得整库重写一次。 */
export const CONVERT_MIN_FREE_PAGES = 256
/** 整库重写的存活页上限：重写代价随存活页线性（实测 ~13µs/页），2048 页约 30ms 封顶。
 *  超限的存量库本轮不转换——宁可保留高水位，也不在让利路径上长时间独占事件循环。 */
export const CONVERT_VACUUM_LIVE_PAGE_MAX = 2048
/** 回收段的写锁等待档（SQLite busy_timeout）：回收是让利动作，不为抢锁拖住调用方。 */
export const MAINTENANCE_BUSY_TIMEOUT_MS = 250

/** 回收结果：`mode` 说明本轮走了哪条路（none = 未达条件）。 */
export interface ReclaimOutcome {
  /** vacuum = 整库重写（顺带把存量库转成增量模式）；incremental = 逐块释放；
   *  none = 未达条件（空闲页不足或存活页超预算） */
  mode: 'vacuum' | 'incremental' | 'none'
  /** 回收前页数（-1 = 读取失败，调用方按未回收处理） */
  pagesBefore: number
  pagesAfter: number
}

/** 在短 busy_timeout 档内执行：维护是让利动作，不为抢锁拖住调用方，拿不到就本轮跳过。
 *  裁剪与回收都用它——两处都是后台维护，等不到锁的代价远大于「这一轮不做」。 */
export function withShortBusyTimeout<T>(db: DatabaseSync, body: () => T): T {
  const prev = (db.prepare('PRAGMA busy_timeout').get() as { timeout?: number } | undefined)?.timeout ?? 5000
  db.exec(`PRAGMA busy_timeout = ${MAINTENANCE_BUSY_TIMEOUT_MS}`)
  try {
    return body()
  } finally {
    db.exec(`PRAGMA busy_timeout = ${prev}`)
  }
}

/** 折 WAL 进主库并截断：页数/文件尺寸读数要它才准，回收后的体积也要它才落盘。busy
 *  （另有连接持读事务）时不强求——返回 false 交调用方按「本轮未回收」处理，不上抛。 */
export function truncateWal(db: DatabaseSync): boolean {
  const r = db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get() as { busy?: number } | undefined
  return (r?.busy ?? 0) === 0
}

/** 页数/空闲页数读数（廉价 header 读；拿不到按 -1/0 处理，调用方据此退化为「不回收」）。 */
export function pageStats(db: DatabaseSync): { pages: number; free: number } {
  const pages = (db.prepare('PRAGMA page_count').get() as { page_count?: number } | undefined)?.page_count ?? -1
  const free =
    (db.prepare('PRAGMA freelist_count').get() as { freelist_count?: number } | undefined)?.freelist_count ?? 0
  return { pages, free }
}

/** 单步回收的结果：`done` = 没有更多可做（调用方据此停止循环），`released` = 本步释放的页数。 */
interface ReclaimStep {
  outcome: ReclaimOutcome
  done: boolean
}

/**
 * 走一步回收。三种出口：
 * - `vacuum`：整库重写（顺带把存量库转成增量模式）——一步做完，done；
 * - `incremental`：释放了一块空闲页，`done=false` 表示还有余量（async 版据此逐块继续并让出）；
 * - `none`：未达条件，done。
 *
 * 抽成「一步」是为了让同步与异步两个入口共用同一套判据：cache/index.db 的重建是同步函数，
 * 不能 await，但它恰恰是最需要回收的地方（整表重写）。两份实现各写一遍判据必然漂移。
 */
function reclaimStep(db: DatabaseSync, force: boolean): ReclaimStep {
  const mode = readAutoVacuumMode(db)
  const before = pageStats(db)
  if (before.pages < 0) return { outcome: { mode: 'none', pagesBefore: -1, pagesAfter: -1 }, done: true }
  if (mode === AUTO_VACUUM_NONE) {
    const live = before.pages - before.free
    if (before.free < CONVERT_MIN_FREE_PAGES || live > CONVERT_VACUUM_LIVE_PAGE_MAX) {
      return { outcome: { mode: 'none', pagesBefore: before.pages, pagesAfter: before.pages }, done: true }
    }
    return withShortBusyTimeout(db, () => {
      db.exec('PRAGMA auto_vacuum = INCREMENTAL')
      db.exec('VACUUM')
      truncateWal(db)
      return {
        outcome: { mode: 'vacuum' as const, pagesBefore: before.pages, pagesAfter: pageStats(db).pages },
        done: true,
      }
    })
  }
  if (before.free === 0 || (!force && before.free < RELEASE_MIN_FREE_PAGES)) {
    return { outcome: { mode: 'none', pagesBefore: before.pages, pagesAfter: before.pages }, done: true }
  }
  withShortBusyTimeout(db, () => {
    db.exec(`PRAGMA incremental_vacuum(${INCREMENTAL_VACUUM_CHUNK_PAGES})`)
  })
  const after = pageStats(db)
  // 还有空闲页且本轮没超预算 → 继续（由调用方决定是否让出）
  const more = after.free > 0
  return { outcome: { mode: 'incremental', pagesBefore: before.pages, pagesAfter: after.pages }, done: !more }
}

/**
 * 回收已释放页 + 截断 WAL（有界，异步版：块与块之间让出事件循环）。
 *
 * `force` = 清空/重建路径的强制档：空闲页阈不再拦——要的就是空间回落；增量档下只要还有
 * 空闲页就收，零档（存量库）下存活页判据仍生效（整库重写的代价上限不能因为强制档而失效）。
 *
 * 必须在**后台路径**上调用（维护任务 / 重建收尾），不要放在请求链路上：整库重写是单段
 * 同步执行（SQLite 无异步入口），代价上限靠 CONVERT_VACUUM_LIVE_PAGE_MAX 封顶。
 */
export async function reclaimFreedSpace(db: DatabaseSync, force = false): Promise<ReclaimOutcome> {
  // 先折 WAL：否则页数是陈旧读数，回收完的体积也看不见（WAL 侧车会留住高水位）
  truncateWal(db)
  const first = pageStats(db)
  if (first.pages < 0) return { mode: 'none', pagesBefore: -1, pagesAfter: -1 }
  let firstOutcome: ReclaimOutcome | null = null
  let pagesBefore = first.pages
  let pagesAfter = first.pages
  let mode: ReclaimOutcome['mode'] = 'none'
  let budget = 0
  for (;;) {
    const step = reclaimStep(db, force)
    if (firstOutcome === null) firstOutcome = step.outcome
    pagesBefore = step.outcome.pagesBefore
    pagesAfter = step.outcome.pagesAfter
    mode = step.outcome.mode
    if (step.done) break
    budget += INCREMENTAL_VACUUM_CHUNK_PAGES
    if (budget >= INCREMENTAL_VACUUM_MAX_PAGES) break
    // 让出点在块与块之间：整轮累计可达数十毫秒，逐块让出后其间 SSE 心跳/其它请求可跑
    await yieldToEventLoop()
  }
  truncateWal(db)
  return { mode, pagesBefore, pagesAfter: pageStats(db).pages > 0 ? pageStats(db).pages : pagesAfter }
}

/**
 * 同步版：不让出事件循环，但在**同一页预算内循环**（INCREMENTAL_VACUUM_MAX_PAGES）。
 *
 * 给同步调用点用（cache/index.db 的重建、rag 的清表都是同步函数：在收尾处收一次，那时库刚
 * 被整表清空，空闲页成百上千）。不走循环只做一步的话，448 页空闲只会被释放 64 页、其余原样
 * 留着——等于这次回收白做，故循环到预算用完为止。
 *
 * **不要用它替代异步版**：没有让出点，多块循环会变成一段长同步段。之所以敢在这里循环，是
 * 因为增量档每块 64 页（亚毫秒级）、且总预算 4096 页封顶（实测 ~10µs/页 ≈ 40ms 上限）；
 * 整库重写那条路径仍由 CONVERT_VACUUM_LIVE_PAGE_MAX 封顶。调用方须是后台/收尾路径。
 */
export function reclaimFreedSpaceSync(db: DatabaseSync, force = false): ReclaimOutcome {
  truncateWal(db)
  const first = pageStats(db)
  if (first.pages < 0) return { mode: 'none', pagesBefore: -1, pagesAfter: -1 }
  let mode: ReclaimOutcome['mode'] = 'none'
  let pagesBefore = first.pages
  let budget = 0
  for (;;) {
    const step = reclaimStep(db, force)
    mode = step.outcome.mode
    pagesBefore = step.outcome.pagesBefore
    if (step.done) break
    budget += INCREMENTAL_VACUUM_CHUNK_PAGES
    if (budget >= INCREMENTAL_VACUUM_MAX_PAGES) break
  }
  truncateWal(db)
  const after = pageStats(db)
  return { mode, pagesBefore, pagesAfter: after.pages > 0 ? after.pages : pagesBefore }
}

/**
 * 新库建表前的档位设置（须在 DDL 之前、且须早于 journal_mode=WAL）。
 *
 * 对**新建空库**生效；存量库此刻语句静默无效（须在同一连接上接着 VACUUM 才落库，见
 * reclaimFreedSpace 的转换路径），故对存量库是零行为变更——真正的收敛在回收路径。
 * 只在**未达目标档**的库上下这条语句：对已是增量档的库重设同一值会让 SQLite 在连接关闭时
 * 改写主库文件（实测：零写入的开/读/关循环里文件内容每轮都变）；而库文件指纹正是若干
 * 缓存层的失效判据，重设会把只读轮询判成「写源已变」而每轮重算。
 */
export function ensureIncrementalAutoVacuum(db: DatabaseSync): void {
  if (readAutoVacuumMode(db) !== AUTO_VACUUM_INCREMENTAL) db.exec('PRAGMA auto_vacuum = INCREMENTAL')
}
