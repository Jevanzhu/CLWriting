/**
 * R0916-7-P3-2（2026-09-25 全项目源码质量与优雅度评审 P3-2）：firstOpenStore 拆出的
 * 首开单元直测——迁移墓碑（clearStaleMigrationTombstone）/ 打开期 PRAGMA 与 WAL
 * （applyOpenPragmas）/ DDL（createEventsSchema）/ 首开装配（schema + 开口标记）。
 *
 * 分层：开库门面行为（引用计数、锁、并发壳、损坏包装、孤儿修复）仍由 store*.test.ts
 * 各族覆盖；本件只直测拆出的命名单元与本文件契约（DDL 幂等、存量库补列、墓碑两态）。
 */
import { describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  AUTO_VACUUM_INCREMENTAL,
  applyOpenPragmas,
  bookHash,
  clearStaleMigrationTombstone,
  createEventsSchema,
  migrateEventsSchema,
  openSessionStore,
  readAutoVacuumMode,
} from '../../src/events/store.js'
import { SqliteSchemaTooNewError } from '../../src/shared/sqlite-migrate.js'
import { SessionFormatUnsupportedError } from '../../src/events/store-rows.js'
import { mkdtempTracked } from '../helpers/temp-dir.js'

function tmpRoot(prefix = 'ev-open-units-'): string {
  return mkdtempTracked(join(tmpdir(), prefix))
}

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

  it('auto_vacuum 定档增量、journal_size_limit 有界；已达档的库重开零写入', () => {
    const root = tmpRoot()
    const dbPath = join(root, 'b.db')
    const db = new DatabaseSync(dbPath)
    try {
      applyOpenPragmas(db)
      db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY)')
      expect(readAutoVacuumMode(db)).toBe(AUTO_VACUUM_INCREMENTAL) // 新库定档增量（空库才接受写值）
    } finally {
      db.close()
    }
    // 已定档的库重开：档位不变，且同值重设被跳过（见 applyOpenPragmas 头注——重设会让
    // SQLite 在关连接时改写主库文件，把「写源指纹」订阅方判成写源已变）
    const again = new DatabaseSync(dbPath)
    try {
      applyOpenPragmas(again)
      expect(readAutoVacuumMode(again)).toBe(AUTO_VACUUM_INCREMENTAL)
      expect(
        (again.prepare('PRAGMA journal_size_limit').get() as { journal_size_limit: number }).journal_size_limit,
      ).toBe(4 * 1024 * 1024)
    } finally {
      again.close()
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

// ── 事件库 schema 版本阶梯（user_version）───────────────────────────────────
// v1 = 既有探列迁移 createEventsSchema 本体（has_branch_meta 生成列 + 部分索引）；
// 原语语义（失败 / 超前 / 零 DDL）见 test/cache/schema.test.ts 直测。

/** 库版本锚读数。 */
const userVersion = (db: DatabaseSync): number =>
  (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version

/** schema cookie——SQLite 只在 schema 真被改写时递增（no-op 的 IF NOT EXISTS 与
 *  user_version 写入都不动它），故「前后不变」= 零有效 DDL 的真库判据。 */
const schemaVersion = (db: DatabaseSync): number =>
  (db.prepare('PRAGMA schema_version').get() as { schema_version: number }).schema_version

/** 形态快照：sqlite_master 全量（type/name/sql）——两路径逐字对拍用。 */
const schemaDump = (db: DatabaseSync): string[] =>
  (
    db
      .prepare("SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name")
      .all() as Array<{ type: string; name: string; sql: string | null }>
  ).map((r) => `${r.type} ${r.name} ${r.sql ?? ''}`)

/** 列签名（生成列是 hidden 列，须走 table_xinfo）。 */
const columnSignature = (db: DatabaseSync, table: string): string =>
  (
    db.prepare(`PRAGMA table_xinfo(${table})`).all() as Array<{
      name: string
      type: string
      notnull: number
      dflt_value: string | null
      pk: number
      hidden: number
    }>
  )
    .map((c) => `${c.name}:${c.type}:${c.notnull}:${c.dflt_value ?? '∅'}:${c.pk}:${c.hidden}`)
    .join('|')

/** 升级前形态 DDL——与 createEventsSchema 的建表文本**逐字同文**（仅生成列缺席）。
 *  对拍要求基线文本与今天 DDL 一致：sqlite_master 存的是建表原文，文本差异会淹没真形态差异。 */
const LEGACY_EVENTS_TABLE_DDL = `CREATE TABLE IF NOT EXISTS events (
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
const LEGACY_SESSIONS_TABLE_DDL = `CREATE TABLE IF NOT EXISTS sessions (
      session_id TEXT PRIMARY KEY,
      format_version INTEGER NOT NULL DEFAULT 1,
      book        TEXT NOT NULL,
      header      TEXT NOT NULL,
      created_at   INTEGER NOT NULL,
      updated_at   INTEGER NOT NULL
    )`

/** 升级前形态的库：events 无生成列（其余列与今天 DDL 逐字相同）+ sessions + 既有事件。 */
function seedLegacyEventsDb(dbPath: string, book: string): void {
  const old = new DatabaseSync(dbPath)
  try {
    old.exec(LEGACY_EVENTS_TABLE_DDL)
    old.exec('CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id, seq)')
    old.exec(LEGACY_SESSIONS_TABLE_DDL)
    old.exec(
      `INSERT INTO sessions (session_id, format_version, book, header, created_at, updated_at)
       VALUES ('s-old', 1, '${book}', '{}', 1, 1)`,
    )
    const ins = old.prepare(
      `INSERT INTO events (session_id, turn, step, type, data, surface_op, shadow_start, shadow_end, source_seqs, replace_generation, created_at)
       VALUES ('s-old', NULL, NULL, ?, ?, 'append', NULL, NULL, NULL, 0, ?)`,
    )
    ins.run('user/message', JSON.stringify({ message: '旧线性一' }), 1)
    ins.run('assistant/message', JSON.stringify({ message: '旧变体', parentSeq: 1, branchId: 'b-9' }), 2)
    ins.run('user/message', JSON.stringify({ message: '旧线性二' }), 3)
  } finally {
    old.close()
  }
}

/** 坏形态库：events 缺 data 列（其余列齐备）——生成列 ALTER 会抛「no such column: data」；
 *  修复（补 data 列）后重跑该步可收敛。 */
function seedBrokenEventsDb(dbPath: string): void {
  const broken = new DatabaseSync(dbPath)
  try {
    broken.exec(`CREATE TABLE events (
        seq         INTEGER PRIMARY KEY,
        session_id  TEXT NOT NULL,
        turn        INTEGER,
        step        INTEGER,
        type        TEXT NOT NULL,
        surface_op  TEXT,
        shadow_start INTEGER,
        shadow_end   INTEGER,
        source_seqs  TEXT,
        replace_generation INTEGER NOT NULL DEFAULT 0,
        created_at   INTEGER NOT NULL
      )`)
    broken.exec('CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id, seq)')
  } finally {
    broken.close()
  }
}

describe('事件库 schema 阶梯（user_version）', () => {
  it('新库首开 → user_version=1；与直接跑 createEventsSchema 的库形态逐字一致', () => {
    const userData = tmpRoot()
    const bookRoot = join(userData, '阶梯新书')
    const store = openSessionStore(userData, bookRoot)
    expect(store).not.toBeNull()
    const probe = new DatabaseSync(sessionDbPath(userData, bookRoot))
    const ref = new DatabaseSync(join(userData, 'ref.db'))
    try {
      expect(userVersion(probe)).toBe(1)
      // 对拍：直接跑「今天的建表函数」的库（DDL 与列定义未变）
      createEventsSchema(ref)
      expect(schemaDump(probe)).toEqual(schemaDump(ref))
      expect(columnSignature(probe, 'events')).toBe(columnSignature(ref, 'events'))
      expect(columnSignature(probe, 'sessions')).toBe(columnSignature(ref, 'sessions'))
    } finally {
      probe.close()
      ref.close()
      store!.close()
    }
  })

  it('存量 v0 库（旧 schema 无生成列 + 已有事件）→ v1 步补列、版本推进、既有事件不被破坏', () => {
    const userData = tmpRoot()
    const bookRoot = join(userData, '阶梯存量书')
    const dbPath = sessionDbPath(userData, bookRoot)
    mkdirSync(join(userData, 'clwriting', 'session'), { recursive: true })
    seedLegacyEventsDb(dbPath, '阶梯存量书')
    // 升级前：版本 0、无生成列
    const before = new DatabaseSync(dbPath)
    expect(userVersion(before)).toBe(0)
    expect(columnSignature(before, 'events')).not.toContain('has_branch_meta')
    before.close()

    const store = openSessionStore(userData, bookRoot)
    expect(store).not.toBeNull()
    try {
      // 既有事件逐条可读、正文原样、顺序不变（数据最重，逐条对拍）
      const events = store!.listEvents('阶梯存量书')
      expect(events.map((e) => (e.data as { message?: string }).message)).toEqual(['旧线性一', '旧变体', '旧线性二'])
      expect(store!.countEvents('阶梯存量书')).toBe(3)
      // 生成列对旧行求值：第 2 条带 branchId/parentSeq → 边界 seq=2
      expect(store!.firstBranchMetaSeq('阶梯存量书')).toBe(2)
    } finally {
      store!.close()
    }
    const after = new DatabaseSync(dbPath)
    try {
      expect(userVersion(after)).toBe(1)
      expect(columnSignature(after, 'events')).toContain('has_branch_meta')
      const rows = after.prepare('SELECT COUNT(*) AS n FROM events').get() as { n: number }
      expect(rows.n).toBe(3)
    } finally {
      after.close()
    }
  })

  it('v0 存量库升级与新建库两路径形态逐字一致（sqlite_master 全量对拍）', () => {
    const userData = tmpRoot()
    const legacyRoot = join(userData, '两路甲')
    const freshRoot = join(userData, '两路乙')
    const legacyPath = sessionDbPath(userData, legacyRoot)
    mkdirSync(join(userData, 'clwriting', 'session'), { recursive: true })
    seedLegacyEventsDb(legacyPath, '两路甲')
    const legacyStore = openSessionStore(userData, legacyRoot)
    legacyStore!.close()
    const freshStore = openSessionStore(userData, freshRoot)
    freshStore!.close()

    const legacyDb = new DatabaseSync(legacyPath)
    const freshDb = new DatabaseSync(sessionDbPath(userData, freshRoot))
    try {
      expect(userVersion(legacyDb)).toBe(1)
      expect(userVersion(freshDb)).toBe(1)
      expect(schemaDump(legacyDb)).toEqual(schemaDump(freshDb))
    } finally {
      legacyDb.close()
      freshDb.close()
    }
  })

  it('已在 v1 → 再调零 schema 变更（版本与 schema cookie 均不动）', () => {
    const dir = tmpRoot()
    const db = new DatabaseSync(join(dir, 'idem.db'))
    try {
      const first = migrateEventsSchema(db)
      expect(first.kind).toBe('fresh')
      expect(first.to).toBe(1)
      expect(userVersion(db)).toBe(1)
      const sv = schemaVersion(db)
      const again = migrateEventsSchema(db)
      expect(again.kind).toBe('skipped')
      expect(again.appliedSteps).toEqual([])
      expect(userVersion(db)).toBe(1)
      expect(schemaVersion(db)).toBe(sv)
    } finally {
      db.close()
    }
  })

  it('版本超前（user_version 手工调大）→ 拒绝打开且库零改动（不静默容忍）', () => {
    const userData = tmpRoot()
    const bookRoot = join(userData, '超前书')
    const dbPath = sessionDbPath(userData, bookRoot)
    mkdirSync(join(userData, 'clwriting', 'session'), { recursive: true })
    seedLegacyEventsDb(dbPath, '超前书')
    const seed = new DatabaseSync(dbPath)
    seed.exec('PRAGMA user_version = 99')
    seed.close()

    expect(() => openSessionStore(userData, bookRoot)).toThrow(SqliteSchemaTooNewError)
    expect(() => openSessionStore(userData, bookRoot)).toThrow(/版本超前/)

    const after = new DatabaseSync(dbPath)
    try {
      expect(userVersion(after)).toBe(99) // 未改库
      expect((after.prepare('SELECT COUNT(*) AS n FROM events').get() as { n: number }).n).toBe(3)
      expect(columnSignature(after, 'events')).not.toContain('has_branch_meta') // 未半迁移
    } finally {
      after.close()
    }
  })

  it('sessions.format_version 为未知值 → 拒绝打开（行语义 fail-closed，不当 v1 解析）', () => {
    const userData = tmpRoot()
    const bookRoot = join(userData, '新行书')
    const dbPath = sessionDbPath(userData, bookRoot)
    mkdirSync(join(userData, 'clwriting', 'session'), { recursive: true })
    seedLegacyEventsDb(dbPath, '新行书')
    // 模拟「更新版本应用写入的行」：格式版本抬到本应用不支持的值
    const seed = new DatabaseSync(dbPath)
    seed.exec("UPDATE sessions SET format_version = 2 WHERE session_id = 's-old'")
    seed.close()

    expect(() => openSessionStore(userData, bookRoot)).toThrow(SessionFormatUnsupportedError)
    // 错误须可行动：点名 session_id 与双方版本（旧进程读新库的诊断面）
    expect(() => openSessionStore(userData, bookRoot)).toThrow(/format_version=2/)
    expect(() => openSessionStore(userData, bookRoot)).toThrow(/升级应用版本/)

    // 库零改动（未做任何「按 v1 解释」的写入/迁移）
    const after = new DatabaseSync(dbPath)
    try {
      expect(
        (after.prepare(`SELECT format_version AS v FROM sessions WHERE session_id = 's-old'`).get() as { v: number }).v,
      ).toBe(2)
      expect((after.prepare('SELECT COUNT(*) AS n FROM events').get() as { n: number }).n).toBe(3)
    } finally {
      after.close()
    }
  })

  it('sessions.format_version 恒为 1 的正常库照常打开（校验不误伤现行全流程）', () => {
    const userData = tmpRoot()
    const bookRoot = join(userData, '现行书')
    const dbPath = sessionDbPath(userData, bookRoot)
    mkdirSync(join(userData, 'clwriting', 'session'), { recursive: true })
    seedLegacyEventsDb(dbPath, '现行书')
    const store = openSessionStore(userData, bookRoot)
    expect(store).not.toBeNull()
    try {
      expect(store!.countEvents('现行书')).toBe(3)
    } finally {
      store!.close()
    }
  })

  it('v1 步中途失败（坏表缺 data 列）→ 版本不推进；修复后重开推进到 v1', () => {
    const userData = tmpRoot()
    const bookRoot = join(userData, '半改书')
    const dbPath = sessionDbPath(userData, bookRoot)
    mkdirSync(join(userData, 'clwriting', 'session'), { recursive: true })
    // 坏形态：events 缺 data 列 → 生成列 ALTER 抛「no such column: data」
    seedBrokenEventsDb(dbPath)

    expect(() => openSessionStore(userData, bookRoot)).toThrow(/no such column: data/)

    const mid = new DatabaseSync(dbPath)
    try {
      expect(userVersion(mid)).toBe(0) // 失败步不推进
      expect(tableNames(mid)).not.toContain('sessions') // 失败点之后的 DDL 未跑
    } finally {
      mid.close()
    }
    // 修复坏形态 → 重开：v1 步重跑（幂等）并推进版本
    const fix = new DatabaseSync(dbPath)
    fix.exec("ALTER TABLE events ADD COLUMN data TEXT NOT NULL DEFAULT '{}'")
    fix.close()
    const store = openSessionStore(userData, bookRoot)
    expect(store).not.toBeNull()
    store!.close()
    const after = new DatabaseSync(dbPath)
    try {
      expect(userVersion(after)).toBe(1)
      expect(tableNames(after).sort()).toEqual(['events', 'sessions'])
      expect(columnSignature(after, 'events')).toContain('has_branch_meta')
    } finally {
      after.close()
    }
  })
})
