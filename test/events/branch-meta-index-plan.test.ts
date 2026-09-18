/**
 * 0918四轮修复批（B401）回归：firstBranchMetaSeq 分支元数据检索走生成列 + 部分索引。
 *
 * 原缺陷形态：`data LIKE '%"branchId"%' OR data LIKE '%"parentSeq"%'` 谓词无可用索引
 * ——chat-history 真尾窗热区每次请求全表扫描（node:sqlite 同步 API 停事件循环，翻倍
 * 前扩循环里最坏反复全扫）。
 *
 * 修法（方案 A）：events 表加 VIRTUAL 生成列 has_branch_meta（instr 确定性函数，读时
 * 按行求值零存储）+ 部分索引 idx_events_branch_meta(session_id, seq) WHERE
 * has_branch_meta = 1（只收录分支元数据行，体量与全表行数解耦）。存量库首开惰性迁移
 * （PRAGMA table_info 判列 → ALTER 补列 → CREATE INDEX IF NOT EXISTS），新库同路径
 * 补齐，两态 schema 恒等。
 *
 * 钉住面：①新旧两形态（生成列 vs 原 LIKE）结果逐位一致（含正文巧含关键字的误报形态
 * ——两形态同样命中，误报方向安全）；②EXPLAIN QUERY PLAN 实证走部分索引（不全表扫）；
 * ③追加后更新——新写入的分支元数据行被部分索引收录（此前无 meta 的库 append 后能取到）；
 * ④存量库（旧 schema 无生成列）打开自动迁移 + 重复打开幂等。
 */
import { describe, expect, it } from 'vitest'
import { mkdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { openSessionStore, bookHash, type NewEvent } from '../../src/events/store.js'
import { userMessageEvent, assistantMessageEvent } from '../../src/events/chat-bridge.js'
import { mkdtempTracked } from '../helpers/temp-dir.js'

/** 与 src/events/store.ts firstBranchMetaSeq 逐字镜像的生产 SQL（漂移时本用例的计划
 *  断言仍对旧文本生效，故另以源文本钉针防查询侧回退 LIKE，见末用例） */
const PROD_META_SQL = `SELECT MIN(seq) AS s FROM events
         WHERE session_id IN (SELECT session_id FROM sessions WHERE book = ?)
           AND has_branch_meta = 1`
/** 修复前的 LIKE 形态（语义参照，手抄自基线 7fd37bd2） */
const LEGACY_LIKE_SQL = `SELECT MIN(seq) AS s FROM events
         WHERE session_id IN (SELECT session_id FROM sessions WHERE book = ?)
           AND (data LIKE '%"branchId"%' OR data LIKE '%"parentSeq"%')`

describe('0918四轮修复批 B401: firstBranchMetaSeq 生成列 + 部分索引', () => {
  it('新旧两形态结果一致（真分支行 + 正文巧含关键字的误报行 + 纯线性库三种形态）', () => {
    const ud = mkdtempTracked(join(tmpdir(), 'b401-meta-'))
    const store = openSessionStore(ud, '/b401/一致书')!
    try {
      const sid = store.createSession('一致书')
      const evs: NewEvent[] = [
        userMessageEvent('线性正文一'),
        assistantMessageEvent('线性回复一'),
        // 误报形态：正文巧含带引号的键名序列——旧 LIKE 与新 instr 同样命中（方向安全）
        userMessageEvent('正文里写到 "branchId" 这个词'),
        // 真分支元数据行（seq 最小的键载体）
        assistantMessageEvent('变体答案', undefined, undefined, undefined, {
          parentSeq: 1,
          branchId: 'reg-1',
        }),
        userMessageEvent('后续线性'),
      ]
      store.appendEvents(sid, evs)
      expect(store.firstBranchMetaSeq('一致书')).toBe(4)

      // 新旧两形态在同一库上逐位一致（只读旁路连接；WAL 读不互斥）
      const dbPath = join(ud, 'clwriting', 'session', bookHash('/b401/一致书') + '.db')
      const raw = new DatabaseSync(dbPath)
      try {
        const legacy = raw.prepare(LEGACY_LIKE_SQL).get('一致书') as { s: number | null }
        const modern = raw.prepare(PROD_META_SQL).get('一致书') as { s: number | null }
        expect(modern.s).toBe(legacy.s)
        expect(modern.s).toBe(4)
      } finally {
        raw.close()
      }

      // 纯线性库（无任何键载体）：两形态同取 null
      const store2 = openSessionStore(ud, '/b401/线性书')!
      try {
        const sid2 = store2.createSession('线性书')
        store2.appendEvents(sid2, [userMessageEvent('u1'), assistantMessageEvent('a1')])
        expect(store2.firstBranchMetaSeq('线性书')).toBeNull()
        const raw2 = new DatabaseSync(join(ud, 'clwriting', 'session', bookHash('/b401/线性书') + '.db'))
        try {
          expect((raw2.prepare(LEGACY_LIKE_SQL).get('线性书') as { s: number | null }).s).toBeNull()
        } finally {
          raw2.close()
        }
      } finally {
        store2.close()
      }
    } finally {
      store.close()
    }
  })

  it('EXPLAIN QUERY PLAN 实证走 idx_events_branch_meta 部分索引（不全表扫）', () => {
    const ud = mkdtempTracked(join(tmpdir(), 'b401-plan-'))
    const store = openSessionStore(ud, '/b401/计划书')!
    store.close()
    const raw = new DatabaseSync(join(ud, 'clwriting', 'session', bookHash('/b401/计划书') + '.db'))
    try {
      const plan = raw.prepare('EXPLAIN QUERY PLAN ' + PROD_META_SQL).all('计划书') as Array<{ detail: string }>
      const detail = plan.map((r) => r.detail).join('\n')
      expect(detail).toContain('idx_events_branch_meta')
      expect(detail).not.toMatch(/SCAN events(?!\s+USING)/) // 禁裸全表扫
    } finally {
      raw.close()
    }
  })

  it('追加后更新：无 meta 库 append 首条分支行 → 部分索引收录，firstBranchMetaSeq 取到新 seq', () => {
    const ud = mkdtempTracked(join(tmpdir(), 'b401-append-'))
    const store = openSessionStore(ud, '/b401/追加书')!
    try {
      const sid = store.createSession('追加书')
      store.appendEvents(sid, [userMessageEvent('u1'), assistantMessageEvent('a1')])
      expect(store.firstBranchMetaSeq('追加书')).toBeNull()
      // 追加分支元数据行（新写入必须被生成列/部分索引看见——VIRTUAL 列随行求值，
      // 部分索引随 INSERT 维护，无需任何回填）
      const seqs = store.appendEvents(sid, [
        assistantMessageEvent('变体', undefined, undefined, undefined, { parentSeq: 1, branchId: 'reg-1' }),
      ])
      expect(store.firstBranchMetaSeq('追加书')).toBe(seqs[0])
      // 再追加纯线性行 → min 不漂移
      store.appendEvents(sid, [userMessageEvent('u2')])
      expect(store.firstBranchMetaSeq('追加书')).toBe(seqs[0])
    } finally {
      store.close()
    }
  })

  it('存量库（旧 schema 无生成列）打开自动迁移：补列 + 建索引 + 查询正确 + 重复打开幂等', () => {
    const ud = mkdtempTracked(join(tmpdir(), 'b401-legacy-'))
    const dir = join(ud, 'clwriting', 'session')
    const dbPath = join(dir, bookHash('/b401/存量书') + '.db')
    mkdirSync(dir, { recursive: true })
    // 手建「旧 schema」库：events 无 has_branch_meta 列、无部分索引（升级前形态）
    {
      const old = new DatabaseSync(dbPath)
      old.exec(`CREATE TABLE IF NOT EXISTS events (
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
        )`)
      old.exec('CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id, seq)')
      old.exec(`CREATE TABLE IF NOT EXISTS sessions (
          session_id TEXT PRIMARY KEY, format_version INTEGER NOT NULL DEFAULT 1,
          book TEXT NOT NULL, header TEXT NOT NULL,
          created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`)
      old.exec("INSERT INTO sessions (session_id, format_version, book, header, created_at, updated_at) VALUES ('s-old', 1, '存量书', '{}', 1, 1)")
      const ins = old.prepare(
        "INSERT INTO events (session_id, turn, step, type, data, surface_op, shadow_start, shadow_end, source_seqs, replace_generation, created_at) VALUES ('s-old', NULL, NULL, ?, ?, NULL, NULL, NULL, NULL, 0, 1)",
      )
      ins.run('user/message', JSON.stringify({ message: '旧线性' }))
      ins.run('assistant/message', JSON.stringify({ message: '旧变体', parentSeq: 1, branchId: 'reg-9' }))
      ins.run('user/message', JSON.stringify({ message: '旧线性二' }))
      old.close()
    }
    // 首开 = 自动迁移；firstBranchMetaSeq 直接可用且结果正确
    const store = openSessionStore(ud, '/b401/存量书')!
    try {
      expect(store.firstBranchMetaSeq('存量书')).toBe(2)
      // 迁移后面：列 + 部分索引在位（生成列是 hidden 列，判列须走 table_xinfo）
      const raw = new DatabaseSync(dbPath)
      try {
        const cols = raw.prepare('PRAGMA table_xinfo(events)').all() as Array<{ name: string }>
        expect(cols.some((c) => c.name === 'has_branch_meta')).toBe(true)
        const idx = raw.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_events_branch_meta'").all()
        expect(idx).toHaveLength(1)
        // 生成列对新旧行一致求值
        const vals = raw.prepare('SELECT seq, has_branch_meta FROM events ORDER BY seq').all() as Array<{ seq: number; has_branch_meta: number }>
        expect(vals.map((v) => v.has_branch_meta)).toEqual([0, 1, 0])
      } finally {
        raw.close()
      }
    } finally {
      store.close()
    }
    // 重复打开（列已在位）幂等：不抛重复列错，查询结果不变
    const again = openSessionStore(ud, '/b401/存量书')!
    try {
      expect(again.firstBranchMetaSeq('存量书')).toBe(2)
    } finally {
      again.close()
    }
    rmSync(ud, { recursive: true, force: true })
  })

  it('源文本钉针：firstBranchMetaSeq 查询谓词走生成列（防回退 LIKE 全表扫）', () => {
    // r41-tombstone 同款结构契约：读 store.ts 源文本钉查询形态
    const src = readFileSync(join(import.meta.dirname, '../../src/events/store.ts'), 'utf-8')
    expect(src).toMatch(/AND has_branch_meta = 1/)
    expect(src).not.toMatch(/data LIKE '%"branchId"'/)
  })
})
