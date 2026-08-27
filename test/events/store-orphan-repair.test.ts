/**
 * P3 回归：repairOrphanSessions 单会话失败不中断整轮修复。
 *
 * - 一好一坏两个过期孤儿：坏的（触发器模拟库故障）修复失败 → 不抛，好的仍被补 end
 * - 全部失败 → 上抛（系统性故障让打开方感知，兼容旧 throw 语义）
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterAll, beforeAll, describe, it, expect } from 'vitest'
import { openSessionStore, repairOrphanSessions } from '../../src/events/store.js'

let ud = ''
let dbPath = ''
const BOOK_ROOT = '/tmp/clwriting-orphan-repair-book'
const OLD = Date.now() - 2 * 60 * 60 * 1000 // 2h 前：远超 10min 宽限期

beforeAll(() => {
  ud = mkdtempSync(join(tmpdir(), 'clwriting-orphan-ud-'))
  // 借 openSessionStore 建库建表（含 sessions 表），随后真关库拿 dbPath 直连驱动
  const store = openSessionStore(ud, BOOK_ROOT)!
  dbPath = store.dbPath
  store.close()
})

afterAll(() => {
  if (ud) rmSync(ud, { recursive: true, force: true })
})

function openRaw(): DatabaseSync {
  return new DatabaseSync(dbPath)
}

/** 造一个过期孤儿会话（有 session/start 无 end，最后活动远超宽限期） */
function seedOrphan(db: DatabaseSync, sid: string, book: string): void {
  db.prepare(
    `INSERT INTO sessions (session_id, format_version, book, header, created_at, updated_at)
     VALUES (?, 1, ?, '{}', ?, ?)`,
  ).run(sid, book, OLD, OLD)
  db.prepare(
    `INSERT INTO events (session_id, type, data, replace_generation, created_at)
     VALUES (?, 'session/start', '{}', 0, ?)`,
  ).run(sid, OLD)
}

function endCount(db: DatabaseSync, sid: string): number {
  return (db.prepare(
    `SELECT COUNT(*) AS c FROM events WHERE session_id = ? AND type = 'session/end'`,
  ).get(sid) as { c: number }).c
}

describe('P3 repairOrphanSessions 单会话失败不中断', () => {
  it('一好一坏：坏的修复失败不抛，好的照常补 end', () => {
    const db = openRaw()
    try {
      seedOrphan(db, 's-good', '书A')
      seedOrphan(db, 's-bad', '书A')
      // 坏会话模拟库故障：BEFORE INSERT 触发器 RAISE(ABORT)
      db.exec(
        `CREATE TRIGGER fail_bad BEFORE INSERT ON events
         WHEN NEW.session_id = 's-bad' BEGIN SELECT RAISE(ABORT, 'boom'); END`,
      )
      // 旧实现此处直接 throw → s-good 永远补不上；新实现 catch 收集继续
      expect(() => repairOrphanSessions(db, new Set())).not.toThrow()
      expect(endCount(db, 's-good')).toBe(1)
      expect(endCount(db, 's-bad')).toBe(0)
      // O-7 + R64-9（十二轮）：补 end 落修复时刻（> OLD），touch 则用会话真实
      // last_at（= OLD）——两者解耦，updated_at 不冒充「修复时刻」为「活动时刻」
      const row = db.prepare(`SELECT updated_at FROM sessions WHERE session_id = 's-good'`).get() as { updated_at: number }
      expect(row.updated_at).toBe(OLD)
      const endRow = db.prepare(
        `SELECT created_at FROM events WHERE session_id = 's-good' AND type = 'session/end'`,
      ).get() as { created_at: number }
      expect(endRow.created_at).toBeGreaterThan(OLD)
    } finally {
      db.close()
    }
  })

  it('全部失败 → 上抛（系统性故障不被吞）', () => {
    const db = openRaw()
    try {
      db.exec('DELETE FROM events')
      db.exec('DELETE FROM sessions')
      seedOrphan(db, 's-bad-1', '书B')
      seedOrphan(db, 's-bad-2', '书B')
      db.exec(`CREATE TRIGGER fail_all BEFORE INSERT ON events BEGIN SELECT RAISE(ABORT, 'boom'); END`)
      expect(() => repairOrphanSessions(db, new Set())).toThrow()
    } finally {
      db.close()
    }
  })
})

describe('R67-6（十五轮）TOCTOU：他进程在 SELECT 与事务之间补了 end', () => {
  it('BEGIN IMMEDIATE 后事务内复核 starts>ends → 不双补（事件流无成对 interrupted end）', () => {
    const db = openRaw()
    const other = openRaw() // 他进程连接（并发修复方）
    try {
      // 前序用例的故障触发器滞留共享库，先清场
      db.exec('DROP TRIGGER IF EXISTS fail_all')
      db.exec('DROP TRIGGER IF EXISTS fail_bad')
      db.exec('DELETE FROM events')
      db.exec('DELETE FROM sessions')
      seedOrphan(db, 's-r67', '书C')

      // 注入点：包装 exec——repair 走到 BEGIN IMMEDIATE 的前一刻，他进程抢先补上
      // session/end 并提交（外层 SELECT 已跑完，恰是 TOCTOU 窗口的确定性复现）
      let injected = false
      const wrapper = {
        prepare: (sql: string) => db.prepare(sql),
        exec: (sql: string) => {
          if (sql === 'BEGIN IMMEDIATE' && !injected) {
            injected = true
            other.exec(
              `INSERT INTO events (session_id, type, data, replace_generation, created_at)
               VALUES ('s-r67', 'session/end', '{"reason":"interrupted"}', 0, ${Date.now()})`,
            )
          }
          return db.exec(sql)
        },
      } as unknown as DatabaseSync

      repairOrphanSessions(wrapper, new Set())
      // 恰一个 end（他进程的）：旧实现复核缺席会再补一个成对 end
      expect(endCount(db, 's-r67')).toBe(1)
      // 本进程 touch 未跑（复核跳过路径不写 sessions）——updated_at 保持种子值
      const row = db.prepare(`SELECT updated_at FROM sessions WHERE session_id = 's-r67'`).get() as { updated_at: number }
      expect(row.updated_at).toBe(OLD)
    } finally {
      other.close()
      db.close()
    }
  })

  it('无并发时行为守恒：过期孤儿照常补单个 end（复核不误伤正常路径）', () => {
    const db = openRaw()
    try {
      db.exec('DROP TRIGGER IF EXISTS fail_all')
      db.exec('DROP TRIGGER IF EXISTS fail_bad')
      db.exec('DELETE FROM events')
      db.exec('DELETE FROM sessions')
      seedOrphan(db, 's-keep', '书D')
      repairOrphanSessions(db, new Set())
      expect(endCount(db, 's-keep')).toBe(1)
    } finally {
      db.close()
    }
  })
})
