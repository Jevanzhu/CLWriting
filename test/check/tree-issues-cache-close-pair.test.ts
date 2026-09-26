/**
 * R0916-6-P3-5（2026-09-16 评审修复批）：check 域 prepared 语句缓存配对 close 回归。
 * 形态镜像 rag 域 rag-prepared-cache-release.test.ts：node:sqlite 的 StatementSync 强引用
 * 其 DatabaseSync，tree-issues-cache 的 preparedByDb（WeakMap<db, Map<sql, stmt>>）值侧
 * Map → stmt → db 与弱键构成 ephemeron 环——裸 close 后条目不随 GC 消失，每次开/关
 * 滞留 ~0.35KB 线性堆积。修复 = closeTreeIssuesDb（先 preparedByDb.delete 再 close）断链。
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { closeTreeIssuesDb, readTreeIssuesCache, writeTreeIssuesCache } from '../../src/check/tree-issues-cache.js'
import { ensureTreeIssuesTables } from '../../src/cache/schema.js'

const here = join(import.meta.dirname, '../../src')

describe('R0916-6-P3-5: tree-issues prepared 缓存配对 close——结构契约', () => {
  // R0917-6-P3-7（2026-09-17 全库源码重评六轮修复批）：断链序本体收编
  // shared/sqlite-prepared.ts 单源，本域契约随之改为「单源本体断链序 + 本域薄封装
  // 确实委托单源」两条（三域同构三份测试的重复锚点合一的落点之一）。
  it('单源本体：先 preparedByDb.delete 再 db.close（断链序不得倒置）', () => {
    const src = readFileSync(join(here, 'shared/sqlite-prepared.ts'), 'utf8')
    const m =
      /export function closeWithPrepared\(db: DatabaseSync\): void \{\s*preparedByDb\.delete\(db\)\s*db\.close\(\)\s*\}/.exec(
        src,
      )
    expect(m, 'closeWithPrepared 必须先摘缓存再关库').not.toBeNull()
  })

  it('closeTreeIssuesDb 委托单源且不裸关（本域不得自持断链序流通路）', () => {
    const src = readFileSync(join(here, 'check/tree-issues-cache.ts'), 'utf8')
    const m = /export function closeTreeIssuesDb\(db: DatabaseSync\): void \{\s*closeWithPrepared\(db\)\s*\}/.exec(src)
    expect(m, 'closeTreeIssuesDb 必须委托 closeWithPrepared').not.toBeNull()
  })

  it('除 closeTreeIssuesDb 本体外不得出现裸关库点（close 一律走配对 helper）', () => {
    const src = readFileSync(join(here, 'check/tree-issues-cache.ts'), 'utf8')
    // 摘除 helper 本体后再扫：closeTreeIssuesDb 内的 db.close() 是全文件唯一合法落点
    const withoutHelper = src.replace(/export function closeTreeIssuesDb\(db: DatabaseSync\): void \{[\s\S]*?\n\}/, '')
    const bare = [...withoutHelper.matchAll(/\bdb\.close\(\)/g)]
    expect(
      bare,
      `裸 close 点位（行号）：${bare.map((m) => withoutHelper.slice(0, m.index).split('\n').length).join(', ')}`,
    ).toHaveLength(0)
  })
})

describe('R0916-6-P3-5: 高频开/关不滞留（功能实测）', () => {
  it.skipIf(typeof (globalThis as { gc?: unknown }).gc !== 'function')(
    'gc 门控：N 次开/关堆增长有界（裸 close 形态 ~0.35KB/次线性堆积）',
    () => {
      const gc = (globalThis as unknown as { gc: () => void }).gc
      const settled = () => {
        let m = Infinity
        for (let i = 0; i < 5; i++) {
          gc()
          m = Math.min(m, process.memoryUsage().heapUsed)
        }
        return m
      }
      const dir = mkdtempSync(join(tmpdir(), 'r0916-6-p3-5-close-'))
      const dbPath = join(dir, 'index.db')
      // 与生产章循环同形态：开库 → 读写各走一次 prepared 缓存路径 → 配对关库
      const cycle = (): void => {
        const db = new DatabaseSync(dbPath)
        ensureTreeIssuesTables(db)
        writeTreeIssuesCache(db, '001-章.md', 1, 2, null, { hasRed: false, verdictRejected: false }, 'fp')
        readTreeIssuesCache(db, '001-章.md', 1, 2, null, 'fp')
        closeTreeIssuesDb(db)
      }
      try {
        for (let i = 0; i < 500; i++) cycle()
        const before = settled()
        const N = 2_500
        for (let i = 0; i < N; i++) cycle()
        const after = settled()
        const growthMB = (after - before) / 1048576
        // 修复前形态 ≈ 0.85MB（0.35KB × 2500，rag R0911-G-P3-4 同源实测系数）；修复后 ≈ 0。
        // N 收窄自 rag 侧用例的 8000（win 单机文件 IO 慢，控总时长），界值比例一致。
        expect(growthMB, `高频开/关后堆增长 ${growthMB.toFixed(2)}MB 超界（裸 close 形态 ~0.85MB）`).toBeLessThan(0.5)
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    },
    120_000,
  )

  it('closeTreeIssuesDb 后句柄失效——库已关，后续 prepare 不再可用', () => {
    const dir = mkdtempSync(join(tmpdir(), 'r0916-6-p3-5-close-'))
    try {
      const db = new DatabaseSync(join(dir, 'index.db'))
      ensureTreeIssuesTables(db)
      writeTreeIssuesCache(db, '001-章.md', 1, 2, null, { hasRed: false, verdictRejected: false }, 'fp')
      closeTreeIssuesDb(db)
      expect(() => db.prepare('SELECT 1')).toThrow()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
