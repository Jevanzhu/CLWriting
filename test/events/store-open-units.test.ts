/**
 * R0916-7-P3-2（2026-09-25 全项目源码质量与优雅度评审 P3-2）：firstOpenStore 拆出的
 * 首开单元直测——迁移墓碑（clearStaleMigrationTombstone）/ 打开期 PRAGMA 与 WAL
 * （applyOpenPragmas）/ DDL（createEventsSchema）/ 首开装配（schema + 开口标记）。
 *
 * 分层：开库门面行为（引用计数、锁、并发壳、损坏包装、孤儿修复）仍由 store*.test.ts
 * 各族覆盖；本件只直测拆出的命名单元与本文件契约（DDL 幂等、存量库补列、墓碑两态）。
 */
import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  applyOpenPragmas,
  bookHash,
  clearStaleMigrationTombstone,
  createEventsSchema,
  openSessionStore,
} from '../../src/events/store.js'
import { mkdtempTracked } from '../helpers/temp-dir.js'

const dirs: string[] = []
function tmpRoot(prefix = 'ev-open-units-'): string {
  const d = mkdtempTracked(join(tmpdir(), prefix))
  dirs.push(d)
  return d
}

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

/** 会话库目录 + 库路径（与 firstOpenStore 落址口径同式） */
function sessionDbPath(userDataPath: string, bookRoot: string): string {
  return join(userDataPath, 'clwriting', 'session', bookHash(bookRoot) + '.db')
}

const tableNames = (db: DatabaseSync): string[] =>
  (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map(
    (r) => r.name,
  )

describe('R0916-7-P3-2 applyOpenPragmas（打开期 PRAGMA + WAL）', () => {
  it('busy_timeout=5000 且 journal_mode=wal；重复调用幂等（不抛）', () => {
    const root = tmpRoot()
    const db = new DatabaseSync(join(root, 'a.db'))
    try {
      applyOpenPragmas(db)
      const mode = db.prepare('PRAGMA journal_mode').get() as { journal_mode: string }
      const busy = db.prepare('PRAGMA busy_timeout').get() as { timeout: number }
      expect(mode.journal_mode).toBe('wal')
      expect(busy.timeout).toBe(5000)
      expect(() => applyOpenPragmas(db)).not.toThrow() // 发送 WAL 为 no-op，重开库路径幂等
      expect((db.prepare('PRAGMA journal_mode').get() as { journal_mode: string }).journal_mode).toBe('wal')
    } finally {
      db.close()
    }
  })
})

describe('R0916-7-P3-2 createEventsSchema（首开 DDL）', () => {
  it('新库：events/sessions 表 + 两条索引就位；重复调用幂等', () => {
    const root = tmpRoot()
    const db = new DatabaseSync(join(root, 'new.db'))
    try {
      createEventsSchema(db)
      expect(tableNames(db).sort()).toEqual(['events', 'sessions'])
      const indexes = (
        db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all() as Array<{ name: string }>
      ).map((r) => r.name)
      expect(indexes).toContain('idx_events_session')
      expect(indexes).toContain('idx_events_branch_meta')
      const cols = (db.prepare('PRAGMA table_xinfo(events)').all() as Array<{ name: string }>).map((c) => c.name)
      expect(cols).toContain('has_branch_meta') // 生成列（hidden=2，table_xinfo 才列出）
      expect(() => createEventsSchema(db)).not.toThrow() // 重启开库重跑 DDL 幂等
    } finally {
      db.close()
    }
  })

  it('存量库（无生成列的老 events 表）：惰性 ALTER 补列 + 建部分索引，且生成列判定生效', () => {
    const root = tmpRoot()
    const db = new DatabaseSync(join(root, 'legacy.db'))
    try {
      db.exec(
        `CREATE TABLE events (
          seq INTEGER PRIMARY KEY,
          session_id TEXT NOT NULL,
          type TEXT NOT NULL,
          data TEXT NOT NULL,
          created_at INTEGER NOT NULL
        )`,
      )
      createEventsSchema(db) // 老 schema 走到 table_xinfo 判列 → ALTER 补列
      const cols = (db.prepare('PRAGMA table_xinfo(events)').all() as Array<{ name: string }>).map((c) => c.name)
      expect(cols).toContain('has_branch_meta')
      // 生成列语义：data 含 branchId/parentSeq 键 → 1（部分索引命中面），否则 0
      db.prepare('INSERT INTO events (session_id, type, data, created_at) VALUES (?, ?, ?, ?)').run(
        'ws-1',
        'user/message',
        JSON.stringify({ message: 'x', branchId: 'b1', parentSeq: 3 }),
        1,
      )
      db.prepare('INSERT INTO events (session_id, type, data, created_at) VALUES (?, ?, ?, ?)').run(
        'ws-1',
        'user/message',
        JSON.stringify({ message: 'y' }),
        2,
      )
      const flags = (
        db.prepare('SELECT has_branch_meta AS h FROM events ORDER BY seq').all() as Array<{ h: number }>
      ).map((r) => r.h)
      expect(flags).toEqual([1, 0])
      expect(() => createEventsSchema(db)).not.toThrow() // 已在位不再重跑 ALTER（duplicate column 不犯）
    } finally {
      db.close()
    }
  })
})

describe('R0916-7-P3-2 clearStaleMigrationTombstone（迁移墓碑两态）', () => {
  const setup = (): { userData: string; dir: string; bookRoot: string; dbPath: string } => {
    const userData = tmpRoot()
    const bookRoot = join(userData, '书名目录')
    mkdirSync(bookRoot, { recursive: true })
    const dbPath = sessionDbPath(userData, bookRoot)
    mkdirSync(join(userData, 'clwriting', 'session'), { recursive: true })
    return { userData, dir: join(userData, 'clwriting', 'session'), bookRoot, dbPath }
  }

  it('无墓碑 → 直通（不建库、不清除任何东西）', () => {
    const { bookRoot, dbPath } = setup()
    expect(() => clearStaleMigrationTombstone(bookRoot, dbPath)).not.toThrow()
    expect(existsSync(dbPath)).toBe(false)
  })

  it('活库在位 + 墓碑并存 → 直通（墓碑分支只在 .db 缺失时走，不解析墓碑）', () => {
    const { bookRoot, dbPath } = setup()
    writeFileSync(dbPath, '')
    writeFileSync(dbPath + '.migrated', '{"to": "/books/新') // 半截 JSON：走不到解析
    expect(() => clearStaleMigrationTombstone(bookRoot, dbPath)).not.toThrow()
    expect(existsSync(dbPath + '.migrated')).toBe(true) // 未动
  })

  it('不可解析墓碑 → fail-closed 抛错，墓碑保留且不建空库', () => {
    const { bookRoot, dbPath } = setup()
    writeFileSync(dbPath + '.migrated', '{"to": "/books/新')
    expect(() => clearStaleMigrationTombstone(bookRoot, dbPath)).toThrow(/墓碑不可解析/)
    expect(existsSync(dbPath + '.migrated')).toBe(true)
    expect(existsSync(dbPath)).toBe(false)
  })

  it('墓碑指向的新库活着但旧根已不存在 → 抛「已随书改名迁移」，墓碑保留', () => {
    const { userData, bookRoot, dbPath } = setup()
    const newDb = join(userData, 'clwriting', 'session', 'deadbeefdeadbeef.db')
    writeFileSync(newDb, '')
    writeFileSync(dbPath + '.migrated', JSON.stringify({ to: newDb, at: 1 }))
    // 旧书根目录已不存在（书确实改名迁走）：stale 视图的迟来首开必须被拒
    rmSync(bookRoot, { recursive: true, force: true })
    expect(() => clearStaleMigrationTombstone(bookRoot, dbPath)).toThrow(/已随书改名迁移/)
    expect(existsSync(dbPath + '.migrated')).toBe(true)
    expect(existsSync(dbPath)).toBe(false)
  })

  it('过期墓碑（同路径重新建书 / 指向的新库也没了 / 无指向）→ 清除放行，不抛', () => {
    // 旧根目录又在（同路径重新建书）
    const a = setup()
    writeFileSync(a.dbPath + '.migrated', JSON.stringify({ to: join(a.userData, '不存在.db'), at: 1 }))
    expect(() => clearStaleMigrationTombstone(a.bookRoot, a.dbPath)).not.toThrow()
    expect(existsSync(a.dbPath + '.migrated')).toBe(false)
    // 旧根不在但墓碑指向的新库也不存在（再迁移/已删书）
    const b = setup()
    rmSync(b.bookRoot, { recursive: true, force: true })
    writeFileSync(b.dbPath + '.migrated', JSON.stringify({ to: join(b.userData, '不存在.db'), at: 1 }))
    expect(() => clearStaleMigrationTombstone(b.bookRoot, b.dbPath)).not.toThrow()
    expect(existsSync(b.dbPath + '.migrated')).toBe(false)
    // 墓碑缺 to（空指向）同按过期处理
    const c = setup()
    rmSync(c.bookRoot, { recursive: true, force: true })
    writeFileSync(c.dbPath + '.migrated', JSON.stringify({ at: 1 }))
    expect(() => clearStaleMigrationTombstone(c.bookRoot, c.dbPath)).not.toThrow()
    expect(existsSync(c.dbPath + '.migrated')).toBe(false)
  })
})

describe('R0916-7-P3-2 首开装配（DDL + 开口标记接线）', () => {
  it('openSessionStore 首开：WAL + 两表就位、开口标记在位；close 后标记注销', () => {
    const userData = tmpRoot()
    const bookRoot = join(userData, '装配书')
    const store = openSessionStore(userData, bookRoot)
    expect(store).not.toBeNull()
    const dbPath = sessionDbPath(userData, bookRoot)
    const marker = dbPath + '.open-' + process.pid
    try {
      expect(existsSync(dbPath)).toBe(true)
      expect(existsSync(marker)).toBe(true) // 预置：开口标记登记在首开段内
      const probe = new DatabaseSync(dbPath)
      try {
        expect((probe.prepare('PRAGMA journal_mode').get() as { journal_mode: string }).journal_mode).toBe('wal')
        expect(tableNames(probe).sort()).toEqual(['events', 'sessions'])
      } finally {
        probe.close()
      }
      const sid = store!.createSession('装配书', { book: '装配书' })
      expect(
        store!.appendEvents(sid, [{ type: 'user/message', data: { message: 'hi' }, surfaceOp: 'append' }]),
      ).toHaveLength(1)
    } finally {
      store!.close()
    }
    expect(existsSync(marker)).toBe(false) // 引用归零 → 注销开口标记
  })
})
