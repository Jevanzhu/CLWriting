import { describe, test, expect } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAllTables, clearAllTables, ensureTreeIssuesTables, migrateCacheSchema } from '../../src/cache/schema.js'
import {
  migrateSqlite,
  SqliteSchemaTooNewError,
  type SqliteMigrationConn,
  type SqliteMigrationPlan,
} from '../../src/shared/sqlite-migrate.js'
import { syncLead, loadLeadFromCache, syncChapter, syncSummary, setMeta, getMeta } from '../../src/cache/sync.js'
import type { Lead } from '../../src/format/types.js'
import { mkdtempTracked } from '../helpers/temp-dir.js'

function makeDb(): { db: DatabaseSync; dir: string } {
  const dir = mkdtempTracked(join(tmpdir(), '北境往事-'))
  const db = new DatabaseSync(join(dir, 'index.db'))
  createAllTables(db)
  return { db, dir }
}

test('createAllTables: 建 5 表成功', () => {
  const { db, dir } = makeDb()
  const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`).all() as {
    name: string
  }[]
  const names = tables.map((t) => t.name)
  expect(names).toContain('leads')
  expect(names).toContain('lead_history')
  expect(names).toContain('chapters')
  expect(names).toContain('summaries')
  expect(names).toContain('meta')
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

test('syncLead + loadLeadFromCache: 悬念写入回读一致', () => {
  const { db, dir } = makeDb()
  const lead: Lead = {
    编号: '悬念-031',
    标题: '灭门真凶',
    类型: '悬念',
    状态: '已收尾',
    开启章: 12,
    履历: [
      { 章号: 12, 动词: '埋下', 证据: '焦痕' },
      { 章号: 47, 动词: '推进', 证据: '狗不叫' },
      { 章号: 152, 动词: '回收', 证据: '二叔是真凶' },
    ],
    _path: '大纲/悬念/悬念-031-灭门真凶.md',
  }
  syncLead(db, lead)
  const loaded = loadLeadFromCache(db, '悬念-031')
  expect(loaded).not.toBeNull()
  expect(loaded!.编号).toBe('悬念-031')
  expect(loaded!.类型).toBe('悬念')
  expect(loaded!.开启章).toBe(12)
  expect(loaded!.履历).toHaveLength(3)
  expect(loaded!.履历[1]!.动词).toBe('推进')
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

test('syncLead: 成长线特化字段（cur_realm）映射', () => {
  const { db, dir } = makeDb()
  const lead: Lead = {
    编号: '成长线-003',
    标题: '林晚修为',
    类型: '成长线',
    状态: '进行中',
    开启章: 3,
    当前境界: '筑基',
    履历: [{ 章号: 88, 动词: '跃迁', 证据: '渡过心魔劫' }],
    _path: '大纲/成长线/成长线-003.md',
  }
  syncLead(db, lead)
  const loaded = loadLeadFromCache(db, '成长线-003')
  expect(loaded!.当前境界).toBe('筑基')
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

test('syncLead: 幂等（重复写不重复履历）', () => {
  const { db, dir } = makeDb()
  const lead: Lead = {
    编号: '悬念-001',
    标题: 'a',
    类型: '悬念',
    状态: '进行中',
    开启章: 1,
    履历: [{ 章号: 1, 动词: '埋下', 证据: 'x' }],
    _path: 'p',
  }
  syncLead(db, lead)
  syncLead(db, lead) // 重复
  const count = db.prepare('SELECT count(*) AS c FROM lead_history WHERE lead_id=?').get('悬念-001') as { c: number }
  expect(count.c).toBe(1) // 不重复
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

test('syncChapter + syncSummary + setMeta', () => {
  const { db, dir } = makeDb()
  syncChapter(db, {
    章号: 152,
    标题: '北境的雪',
    钩子类型: '悬念钩',
    钩子强弱: '强',
    情绪定位: '转折',
    _wordCount: 3200,
    _path: '定稿/正文/152-北境的雪.md',
  })
  const ch = db.prepare('SELECT * FROM chapters WHERE number=152').get() as Record<string, unknown>
  expect(ch['title']).toBe('北境的雪')
  expect(ch['word_count']).toBe(3200)
  expect(ch['hook_type']).toBe('悬念钩')

  syncSummary(db, 'chapter', 152, '定稿/摘要/章摘要/152.md')
  const sm = db.prepare('SELECT path FROM summaries WHERE scope=? AND ref=?').get('chapter', 152) as { path: string }
  expect(sm.path).toBe('定稿/摘要/章摘要/152.md')

  setMeta(db, 'rebuilt_at', '2026-06-16T12:00:00Z')
  expect(getMeta(db, 'rebuilt_at')).toBe('2026-06-16T12:00:00Z')

  db.close()
  rmSync(dir, { recursive: true, force: true })
})

test('clearAllTables: 清空保留结构', () => {
  const { db, dir } = makeDb()
  setMeta(db, 'k', 'v')
  clearAllTables(db)
  expect(getMeta(db, 'k')).toBeNull()
  // 表还在
  const tables = db.prepare(`SELECT count(*) AS c FROM sqlite_master WHERE type='table'`).get() as { c: number }
  expect(tables.c).toBeGreaterThanOrEqual(5)
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

// ── 共享原语：sqlite schema 版本阶梯（user_version）─────────────────────────
// 原语语义（失败 / 超前 / 零 DDL）在此直测；三库各自的接入断言见本档下方与
// test/events/store-open-units.test.ts、test/rag/rag.test.ts。

/** 库版本锚读数（与 PRAGMA user_version 同源）。 */
function userVersion(db: DatabaseSync): number {
  return (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version
}

/** schema cookie——SQLite 只在 schema 真被改写时递增（no-op 的 IF NOT EXISTS 与
 *  user_version 写入都不动它），故「两次调用前后不变」= 零有效 DDL 的真库判据。 */
function schemaVersion(db: DatabaseSync): number {
  return (db.prepare('PRAGMA schema_version').get() as { schema_version: number }).schema_version
}

/** 列签名（名:型:非空:默认:主键序）——两路径形态对拍用。 */
function columnSignature(db: DatabaseSync, table: string): string {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{
    name: string
    type: string
    notnull: number
    dflt_value: string | null
    pk: number
  }>
  return cols.map((c) => `${c.name}:${c.type}:${c.notnull}:${c.dflt_value ?? '∅'}:${c.pk}`).join('|')
}

/** 记账替身：只实现原语触达的窄接口——exec 全记录，prepare 按 SQL 回放版本 / 对象计数。
 *  「已在目标版本 = 一条语句都不跑」在真库上不可观测（no-op 语句同样无痕），故用替身断言。 */
function recordingConn(version: number, objectCount: number): { conn: SqliteMigrationConn; execs: string[] } {
  const execs: string[] = []
  const conn: SqliteMigrationConn = {
    exec(sql: string): void {
      execs.push(sql)
    },
    prepare(sql: string): { get(): unknown } {
      if (sql.startsWith('PRAGMA user_version')) return { get: () => ({ user_version: version }) }
      if (sql.includes('sqlite_master')) return { get: () => ({ n: objectCount }) }
      throw new Error(`记账替身未预期的 prepare：${sql}`)
    },
  }
  return { conn, execs }
}

/** 跑到即失败的步（「不该执行」的断言体）。 */
function forbiddenStep(): never {
  throw new Error('步不应被执行')
}

describe('sqlite 版本阶梯原语（shared/sqlite-migrate）', () => {
  test('已在目标版本 → skipped 且零语句（含零版本写入）', () => {
    const { conn, execs } = recordingConn(2, 7)
    const plan: SqliteMigrationPlan<SqliteMigrationConn> = {
      tag: 'probe',
      target: 2,
      steps: [
        { to: 1, run: forbiddenStep },
        { to: 2, run: forbiddenStep },
      ],
      createFresh: forbiddenStep,
    }
    const outcome = migrateSqlite(conn, plan)
    expect(outcome.kind).toBe('skipped')
    expect(outcome.from).toBe(2)
    expect(outcome.to).toBe(2)
    expect(outcome.appliedSteps).toEqual([])
    expect(execs).toEqual([])
  })

  test('空库 → fresh 直达目标版本（跑 createFresh、不跑历史步）', () => {
    const { conn, execs } = recordingConn(0, 0)
    let freshRan = false
    const outcome = migrateSqlite(conn, {
      tag: 'probe',
      target: 2,
      steps: [
        { to: 1, run: forbiddenStep },
        { to: 2, run: forbiddenStep },
      ],
      createFresh: () => {
        freshRan = true
      },
    })
    expect(outcome.kind).toBe('fresh')
    expect(outcome.appliedSteps).toEqual([])
    expect(freshRan).toBe(true)
    expect(execs).toEqual(['PRAGMA user_version = 2'])
  })

  test('v0 存量库 → 逐级执行缺的步、每步后版本推进、数据未损；再跑零动作', () => {
    const dir = mkdtempTracked(join(tmpdir(), '阶梯原语-'))
    const db = new DatabaseSync(join(dir, 'a.db'))
    try {
      db.exec('CREATE TABLE t (a INTEGER PRIMARY KEY, v TEXT NOT NULL)')
      db.prepare('INSERT INTO t (v) VALUES (?)').run('存量行')
      const seen: number[] = []
      const plan: SqliteMigrationPlan<DatabaseSync> = {
        tag: 'probe',
        target: 2,
        steps: [
          {
            to: 1,
            run: (d) => {
              seen.push(1)
              d.exec('ALTER TABLE t ADD COLUMN b TEXT')
            },
          },
          {
            to: 2,
            run: (d) => {
              seen.push(2)
              d.exec('ALTER TABLE t ADD COLUMN c TEXT')
            },
          },
        ],
        createFresh: () => {
          throw new Error('存量库不该走新库路径')
        },
      }
      const outcome = migrateSqlite(db, plan)
      expect(outcome.kind).toBe('applied')
      expect(outcome.from).toBe(0)
      expect(outcome.appliedSteps).toEqual([1, 2])
      expect(seen).toEqual([1, 2])
      expect(userVersion(db)).toBe(2)
      expect(db.prepare('SELECT v FROM t').get()).toEqual({ v: '存量行' })
      const cols = columnSignature(db, 't')
      expect(cols).toContain('b')
      expect(cols).toContain('c')
      // 已在目标 → 零动作（版本不动、schema cookie 不动）
      const sv = schemaVersion(db)
      expect(migrateSqlite(db, plan).kind).toBe('skipped')
      expect(userVersion(db)).toBe(2)
      expect(schemaVersion(db)).toBe(sv)
    } finally {
      db.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('步失败 → 版本不推进、原错误原样上抛；重试从失败步续跑（前级不重跑）', () => {
    const dir = mkdtempTracked(join(tmpdir(), '阶梯失败-'))
    const db = new DatabaseSync(join(dir, 'a.db'))
    try {
      db.exec('CREATE TABLE t (a INTEGER PRIMARY KEY)')
      const seen: number[] = []
      let failOnce = true
      const plan: SqliteMigrationPlan<DatabaseSync> = {
        tag: 'probe',
        target: 2,
        steps: [
          {
            to: 1,
            run: (d) => {
              seen.push(1)
              d.exec('ALTER TABLE t ADD COLUMN b TEXT')
            },
          },
          {
            to: 2,
            run: (d) => {
              seen.push(2)
              if (failOnce) {
                failOnce = false
                throw new Error('磁盘满（构造）')
              }
              d.exec('ALTER TABLE t ADD COLUMN c TEXT')
            },
          },
        ],
        createFresh: forbiddenStep,
      }
      expect(() => migrateSqlite(db, plan)).toThrow('磁盘满（构造）')
      // 失败步不推进版本、其 DDL 未生效
      expect(userVersion(db)).toBe(1)
      expect(columnSignature(db, 't')).not.toContain('c')
      // 重试：从失败步续跑（步 1 已在版本内，不重跑），推进到目标
      const retry = migrateSqlite(db, plan)
      expect(retry.kind).toBe('applied')
      expect(retry.from).toBe(1)
      expect(retry.appliedSteps).toEqual([2])
      expect(seen).toEqual([1, 2, 2])
      expect(userVersion(db)).toBe(2)
      expect(columnSignature(db, 't')).toContain('c')
    } finally {
      db.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('库版本超前 → SqliteSchemaTooNewError 拒绝（不静默容忍），库零改动', () => {
    const dir = mkdtempTracked(join(tmpdir(), '阶梯超前-'))
    const db = new DatabaseSync(join(dir, 'a.db'))
    try {
      db.exec('CREATE TABLE t (a INTEGER PRIMARY KEY)')
      db.prepare('INSERT INTO t (a) VALUES (1)').run()
      db.exec('PRAGMA user_version = 9')
      const plan: SqliteMigrationPlan<DatabaseSync> = {
        tag: 'probe',
        target: 1,
        steps: [{ to: 1, run: forbiddenStep }],
        createFresh: forbiddenStep,
      }
      expect(() => migrateSqlite(db, plan)).toThrow(SqliteSchemaTooNewError)
      expect(() => migrateSqlite(db, plan)).toThrow(/版本超前/)
      let caught: unknown
      try {
        migrateSqlite(db, plan)
      } catch (e) {
        caught = e
      }
      expect(caught).toBeInstanceOf(SqliteSchemaTooNewError)
      const err = caught as SqliteSchemaTooNewError
      expect(err.tag).toBe('probe')
      expect(err.dbVersion).toBe(9)
      expect(err.target).toBe(1)
      // 拒绝 = 不碰库：版本与数据原样
      expect(userVersion(db)).toBe(9)
      expect(db.prepare('SELECT COUNT(*) AS n FROM t').get()).toEqual({ n: 1 })
    } finally {
      db.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('阶梯缺号 / 跳号（steps 与 target 不连续）→ 配置错误上抛，不落任何语句', () => {
    const { conn, execs } = recordingConn(0, 3)
    // 步数不足 = 缺号
    expect(() =>
      migrateSqlite(conn, {
        tag: 'probe',
        target: 2,
        steps: [{ to: 1, run: forbiddenStep }],
        createFresh: forbiddenStep,
      }),
    ).toThrow(/须恰有 2 步/)
    // 步数够但 to 跳号
    expect(() =>
      migrateSqlite(conn, {
        tag: 'probe',
        target: 2,
        steps: [
          { to: 1, run: forbiddenStep },
          { to: 3, run: forbiddenStep },
        ],
        createFresh: forbiddenStep,
      }),
    ).toThrow(/阶梯须连续升序/)
    expect(execs).toEqual([])
  })
})

// ── 缓存库（index.db）接入：v1 = 既有探列补列（epoch_fp）──────────────────

describe('缓存库 schema 阶梯（index.db / user_version）', () => {
  /** 建一个「升级前」形态的 index.db：五张主表 + 旧树红点表（无 epoch_fp）+ 既有数据。 */
  function seedLegacyCacheDb(dbPath: string): void {
    const db = new DatabaseSync(dbPath)
    try {
      createAllTables(db) // 五张主表按今天 DDL 建
      // 树红点表回退到无 epoch_fp 的旧形态（重建表以复现旧 schema）
      db.exec('DROP TABLE tree_issues_cache')
      db.exec('DROP TABLE tree_issues_meta')
      db.exec(`CREATE TABLE tree_issues_cache (
        rel_path TEXT PRIMARY KEY, mtime_ms INTEGER NOT NULL, size INTEGER NOT NULL,
        verdict_fp TEXT, report_json TEXT NOT NULL)`)
      db.exec('CREATE TABLE tree_issues_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
      syncLead(db, {
        编号: '悬念-031',
        标题: '存量账本',
        类型: '悬念',
        状态: '进行中',
        开启章: 1,
        履历: [{ 章号: 1, 动词: '埋下', 证据: '旧行证据' }],
        _path: '布线/悬念/悬念-031.md',
      })
      db.prepare(
        'INSERT INTO tree_issues_cache (rel_path, mtime_ms, size, verdict_fp, report_json) VALUES (?, ?, ?, NULL, ?)',
      ).run('写作/正文/001-第1章.md', 11, 22, '{"hasRed":true,"verdictRejected":false}')
    } finally {
      db.close()
    }
  }

  test('新库 → fresh 直达 v1；与 v0 存量库走 v1 步后的形态逐字一致（两路径对拍）', () => {
    const dir = mkdtempTracked(join(tmpdir(), '缓存阶梯-'))
    try {
      const freshDb = new DatabaseSync(join(dir, 'fresh.db'))
      const legacyPath = join(dir, 'legacy.db')
      seedLegacyCacheDb(legacyPath)
      const legacyDb = new DatabaseSync(legacyPath)
      try {
        const fresh = migrateCacheSchema(freshDb)
        expect(fresh.kind).toBe('fresh')
        expect(fresh.to).toBe(1)
        expect(userVersion(freshDb)).toBe(1)

        const upgrade = migrateCacheSchema(legacyDb)
        expect(upgrade.kind).toBe('applied')
        expect(upgrade.appliedSteps).toEqual([1])
        expect(userVersion(legacyDb)).toBe(1)

        // 两路径对拍：表清单 + 各表列签名逐字一致（分叉是最隐蔽的失效形态）
        const tables = (db: DatabaseSync): string[] =>
          (
            db
              .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
              .all() as Array<{ name: string }>
          ).map((t) => t.name)
        expect(tables(legacyDb)).toEqual(tables(freshDb))
        for (const t of tables(freshDb)) {
          expect(columnSignature(legacyDb, t), `表 ${t} 列签名分叉`).toBe(columnSignature(freshDb, t))
        }
        // 升级后补列到位，存量数据未损
        expect(columnSignature(legacyDb, 'tree_issues_cache')).toContain('epoch_fp')
        expect(loadLeadFromCache(legacyDb, '悬念-031')!.履历).toHaveLength(1)
        const legacyRows = legacyDb.prepare('SELECT COUNT(*) AS n FROM tree_issues_cache').get() as { n: number }
        expect(legacyRows.n).toBe(1)
      } finally {
        freshDb.close()
        legacyDb.close()
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('已在 v1 → 再调零 schema 变更（版本与 schema cookie 均不动）', () => {
    const { db, dir } = makeDb() // createAllTables 已建全表、版本仍为 0（今天的存量常态）
    try {
      const first = migrateCacheSchema(db)
      expect(first.kind).toBe('applied') // 列已在位 → v1 步的探列为 no-op，只推版本
      expect(first.from).toBe(0)
      expect(userVersion(db)).toBe(1)
      const sv = schemaVersion(db)
      const again = migrateCacheSchema(db)
      expect(again.kind).toBe('skipped')
      expect(again.appliedSteps).toEqual([])
      expect(userVersion(db)).toBe(1)
      expect(schemaVersion(db)).toBe(sv)
      // 幂等：树红点表探列补列重复调用不抛（duplicate column 不犯）
      expect(() => ensureTreeIssuesTables(db)).not.toThrow()
    } finally {
      db.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('版本超前（user_version 手工调大）→ 拒绝迁移且库零改动', () => {
    const { db, dir } = makeDb()
    try {
      syncLead(db, {
        编号: '悬念-001',
        标题: 'a',
        类型: '悬念',
        状态: '进行中',
        开启章: 1,
        履历: [{ 章号: 1, 动词: '埋下', 证据: 'x' }],
        _path: 'p',
      })
      db.exec('PRAGMA user_version = 5')
      expect(() => migrateCacheSchema(db)).toThrow(SqliteSchemaTooNewError)
      expect(userVersion(db)).toBe(5)
      expect(loadLeadFromCache(db, '悬念-001')!.编号).toBe('悬念-001')
    } finally {
      db.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('v1 步中途失败 → 版本不推进（部分 DDL + 旧版本号）；修复后重试推进到 v1', () => {
    const dir = mkdtempTracked(join(tmpdir(), '缓存阶梯失败-'))
    const dbPath = join(dir, 'index.db')
    try {
      // 坏形态：lead_history 缺 chapter 列 → 建 idx_history_chapter 时抛「no such column」
      const seed = new DatabaseSync(dbPath)
      seed.exec('CREATE TABLE lead_history (lead_id TEXT NOT NULL, seq INTEGER NOT NULL)')
      seed.prepare('INSERT INTO lead_history (lead_id, seq) VALUES (?, ?)').run('悬念-031', 1)
      seed.close()

      const db = new DatabaseSync(dbPath)
      try {
        expect(() => migrateCacheSchema(db)).toThrow(/no such column: chapter/)
        // 版本不推进：下一次打开仍从 v1 步重试
        expect(userVersion(db)).toBe(0)
        // 步内已生效的 DDL 留在库里（部分 DDL + 旧版本号是如实记档的代价）
        const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{
          name: string
        }>
        expect(tables.map((t) => t.name)).toContain('leads')
        // 修复坏形态 → 重试成功、版本推进、存量行未损
        db.exec('ALTER TABLE lead_history ADD COLUMN chapter INTEGER NOT NULL DEFAULT 0')
        const retry = migrateCacheSchema(db)
        expect(retry.kind).toBe('applied')
        expect(userVersion(db)).toBe(1)
        expect(columnSignature(db, 'tree_issues_cache')).toContain('epoch_fp')
        const rows = db.prepare('SELECT lead_id, seq FROM lead_history').all() as Array<{
          lead_id: string
          seq: number
        }>
        expect(rows).toEqual([{ lead_id: '悬念-031', seq: 1 }])
      } finally {
        db.close()
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
