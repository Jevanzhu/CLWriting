/**
 * SQLite 空间回收单源直测（src/fs/sqlite-vacuum.ts）。
 *
 * 这个模块的价值全在「有界」二字上：VACUUM 是单段同步执行（SQLite 无异步入口），没有上限
 * 就会把事件循环独占若干秒。故判据分三面：
 *
 * 1. **新库档位**：建库后 auto_vacuum 为增量档（打开期的 ensureIncrementalAutoVacuum 生效）；
 * 2. **存量库转换**：零档库空闲页不足 / 存活页超上限 → 本轮不动（宁可保留高水位）；
 *    未超限 → 走整库重写并转成增量档；
 * 3. **回收真的回落高水位**：写满一批行 → 删掉 → 回收 → 主库文件字节数变小（用真实临时库
 *    实测，不靠口头结论）。
 *
 * 另锚同步版与异步版的一致性：两者共用同一套判据（reclaimStep），差别只在是否让出与是否
 * 多块循环——故同一库上两版应给出同样的 `mode`。
 */
import { describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { mkdtempTracked } from '../helpers/temp-dir.js'
import { tmpdir } from 'node:os'
import {
  AUTO_VACUUM_INCREMENTAL,
  AUTO_VACUUM_NONE,
  CONVERT_MIN_FREE_PAGES,
  CONVERT_VACUUM_LIVE_PAGE_MAX,
  ensureIncrementalAutoVacuum,
  pageStats,
  readAutoVacuumMode,
  reclaimFreedSpace,
  reclaimFreedSpaceSync,
} from '../../src/fs/sqlite-vacuum.js'

function freshDb(): { db: DatabaseSync; path: string } {
  const dir = mkdtempTracked(join(tmpdir(), 'clw-vacuum-'))
  const path = join(dir, 'test.db')
  const db = new DatabaseSync(path)
  return { db, path }
}

/** 写 n 行（每行 ~2KB，页数涨得够明显）。 */
function fill(db: DatabaseSync, n: number, rowBytes = 2000): void {
  db.exec('CREATE TABLE IF NOT EXISTS t (id INTEGER PRIMARY KEY, blob TEXT)')
  const ins = db.prepare('INSERT INTO t (blob) VALUES (?)')
  const chunk = 'x'.repeat(rowBytes)
  for (let i = 0; i < n; i++) ins.run(`${i}-${chunk}`)
}

/** 造出「存活页 > 转换上限」的库。
 *
 *  用**少量大行**而不是大量小行：页数由字节数决定，而逐行 prepare/run 的固定开销会让
 *  几千次插入耗掉几十秒。20MB / 4KB ≈ 5000 页，远超 2048 的上限。
 *  不写死页数——页容由 SQLite 按页大小与行宽决定，故末尾按实测复核前提是否成立。 */
function fillBeyondConvertLimit(db: DatabaseSync): void {
  fill(db, 200, 100_000) // ~20MB ≈ 5000 页
  const st = pageStats(db)
  if (st.pages - st.free <= CONVERT_VACUUM_LIVE_PAGE_MAX) {
    throw new Error(`夹具未达前提：存活页 ${st.pages - st.free} 未超上限 ${CONVERT_VACUUM_LIVE_PAGE_MAX}`)
  }
}

describe('档位：新库按增量档建、存量库读出真实档位', () => {
  it('ensureIncrementalAutoVacuum 后读回增量档；对已是增量档的库重复调用不改文件', () => {
    const { db, path } = freshDb()
    ensureIncrementalAutoVacuum(db)
    expect(readAutoVacuumMode(db)).toBe(AUTO_VACUUM_INCREMENTAL)
    // 已是目标档 → 不再下语句（重设同一值会让 SQLite 在关连接时改写主文件，见该函数注）
    const sizeBefore = statSync(path).size
    ensureIncrementalAutoVacuum(db)
    expect(readAutoVacuumMode(db)).toBe(AUTO_VACUUM_INCREMENTAL)
    expect(statSync(path).size).toBe(sizeBefore)
    db.close()
  })

  it('未调过 ensure 的库是零档（存量库形态）', () => {
    const { db } = freshDb()
    fill(db, 3)
    expect(readAutoVacuumMode(db)).toBe(AUTO_VACUUM_NONE)
    db.close()
  })
})

describe('回收：真实临时库上高水位必须回落', () => {
  it('写满 → 删光 → 强制回收 → 主库文件字节数变小', () => {
    const { db, path } = freshDb()
    ensureIncrementalAutoVacuum(db)
    fill(db, 400) // ~800KB
    db.exec('PRAGMA journal_mode = WAL')
    const big = statSync(path).size
    db.exec('DELETE FROM t')
    const outcome = reclaimFreedSpaceSync(db, true)
    expect(outcome.mode).toBe('incremental')
    const after = statSync(path).size
    expect(after, `回收前 ${big} 字节，回收后 ${after} 字节`).toBeLessThan(big)
    db.close()
  })

  it('零档存量库：空闲页不足 → 不动（不为了收一点空间就整库重写）', () => {
    const { db } = freshDb()
    fill(db, 2) // 远小于 CONVERT_MIN_FREE_PAGES
    db.exec('DELETE FROM t')
    const before = pageStats(db)
    expect(before.free).toBeLessThan(CONVERT_MIN_FREE_PAGES)
    const outcome = reclaimFreedSpaceSync(db, true)
    expect(outcome.mode).toBe('none')
    // 未转换：档位仍是零档
    expect(readAutoVacuumMode(db)).toBe(AUTO_VACUUM_NONE)
    db.close()
  })

  it('零档存量库：存活页超上限 → 本轮不转换（宁可保留高水位，也不长时间独占事件循环）', () => {
    const { db } = freshDb()
    // 先写大量行制造「存活页 > 上限」，再删掉一部分让空闲页够多
    fillBeyondConvertLimit(db)
    db.exec('DELETE FROM t WHERE id <= 100')
    expect(pageStats(db).free).toBeGreaterThanOrEqual(CONVERT_MIN_FREE_PAGES)
    const outcome = reclaimFreedSpaceSync(db, true)
    expect(outcome.mode).toBe('none')
    expect(readAutoVacuumMode(db)).toBe(AUTO_VACUUM_NONE) // 未转换
    db.close()
  })

  it('零档存量库：空闲页够且存活页小 → 整库重写并转成增量档', () => {
    const { db } = freshDb()
    // 先写满再全删：空闲页必然远超转换阈，存活页近零
    fillBeyondConvertLimit(db)
    db.exec('DELETE FROM t')
    const before = pageStats(db)
    expect(before.free).toBeGreaterThanOrEqual(CONVERT_MIN_FREE_PAGES)
    expect(before.pages - before.free).toBeLessThanOrEqual(CONVERT_VACUUM_LIVE_PAGE_MAX)
    const outcome = reclaimFreedSpaceSync(db, true)
    expect(outcome.mode).toBe('vacuum')
    expect(readAutoVacuumMode(db)).toBe(AUTO_VACUUM_INCREMENTAL)
    expect(outcome.pagesAfter).toBeLessThan(outcome.pagesBefore)
    db.close()
  })
})

describe('同步版与异步版同判据', () => {
  it('同一「空闲页不足」形态下两版都给 none', async () => {
    const a = freshDb()
    ensureIncrementalAutoVacuum(a.db)
    fill(a.db, 2)
    a.db.exec('DELETE FROM t')
    const syncOutcome = reclaimFreedSpaceSync(a.db)
    expect(syncOutcome.mode).toBe('none')
    const asyncOutcome = await reclaimFreedSpace(a.db)
    expect(asyncOutcome.mode).toBe('none')
    a.db.close()

    // 零档同理（两版都不该在阈值不足时动手）
    const b = freshDb()
    fill(b.db, 2)
    b.db.exec('DELETE FROM t')
    expect(reclaimFreedSpaceSync(b.db, true).mode).toBe('none')
    expect((await reclaimFreedSpace(b.db, true)).mode).toBe('none')
    b.db.close()
  })

  it('异步版在增量档下能连续处置多块空闲页（让出点在块之间）', async () => {
    const { db } = freshDb()
    ensureIncrementalAutoVacuum(db)
    db.exec('PRAGMA journal_mode = WAL')
    fill(db, 400)
    db.exec('DELETE FROM t')
    const before = pageStats(db)
    expect(before.free).toBeGreaterThan(0)
    const outcome = await reclaimFreedSpace(db, true)
    expect(outcome.mode).toBe('incremental')
    expect(pageStats(db).free).toBe(0) // 整轮把空闲页收干净（预算内）
    db.close()
  })
})

describe('扫描面：回收不会凭空造出库文件', () => {
  it('对已存在的库回收后文件仍在（不删侧车、不改路径）', () => {
    const { db, path } = freshDb()
    ensureIncrementalAutoVacuum(db)
    fill(db, 10)
    reclaimFreedSpaceSync(db, true)
    expect(existsSync(path)).toBe(true)
    db.close()
    expect(existsSync(path)).toBe(true)
  })
})
