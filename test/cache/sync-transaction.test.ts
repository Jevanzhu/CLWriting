/**
 * P3 回归：cache/sync.ts 写语句 .run() + syncLead 履历自包事务（SAVEPOINT）。
 *
 * - syncLead 在外层 rebuild 事务（BEGIN…COMMIT）内可用（嵌套不炸）
 * - syncLead 幂等：重复 sync 履历不重复
 * - 履历 DELETE+INSERT 中途失败 → 回滚不留半截（旧履历原样保留）
 */
import { DatabaseSync } from 'node:sqlite'
import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, expect } from 'vitest'
import { createAllTables } from '../../src/cache/schema.js'
import { syncLead, loadLeadFromCache } from '../../src/cache/sync.js'
import type { Lead } from '../../src/format/types.js'
import { mkdtempTracked } from '../helpers/temp-dir.js'

function makeDb(): { db: DatabaseSync; dir: string } {
  const dir = mkdtempTracked(join(tmpdir(), 'clwriting-sync-txn-'))
  const db = new DatabaseSync(join(dir, 'index.db'))
  createAllTables(db)
  return { db, dir }
}

function leadOf(history: Lead['履历']): Lead {
  return {
    编号: '悬念-001',
    标题: '玉佩',
    类型: '悬念',
    状态: '进行中',
    开启章: 1,
    履历: history,
    _path: '布线/悬念/悬念-001-玉佩.md',
  }
}

test('syncLead 在外层 rebuild 事务（BEGIN…COMMIT）内可用', () => {
  const { db, dir } = makeDb()
  db.exec('BEGIN') // rebuild.ts 的原子重建事务
  try {
    syncLead(db, leadOf([{ 章号: 1, 动词: '埋下', 证据: '玉佩发光' }]))
    db.exec('COMMIT')
  } catch (e) {
    db.exec('ROLLBACK')
    throw e
  }
  expect(loadLeadFromCache(db, '悬念-001')!.履历).toHaveLength(1)
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

test('syncLead 幂等：重复 sync 同一 lead 履历不重复', () => {
  const { db, dir } = makeDb()
  const lead = leadOf([
    { 章号: 1, 动词: '埋下', 证据: 'a' },
    { 章号: 2, 动词: '推进', 证据: 'b' },
  ])
  syncLead(db, lead)
  syncLead(db, lead)
  expect(loadLeadFromCache(db, '悬念-001')!.履历).toHaveLength(2)
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

test('履历 DELETE+INSERT 中途失败 → SAVEPOINT 回滚，旧履历保留', () => {
  const { db, dir } = makeDb()
  syncLead(db, leadOf([{ 章号: 1, 动词: '埋下', 证据: '旧证据' }]))
  // 模拟第二批写入中途故障：第二条履历触发 ABORT
  db.exec(
    `CREATE TRIGGER fail_history BEFORE INSERT ON lead_history
     WHEN NEW.evidence = 'boom' BEGIN SELECT RAISE(ABORT, 'boom'); END`,
  )
  expect(() =>
    syncLead(
      db,
      leadOf([
        { 章号: 2, 动词: '推进', 证据: '新证据' },
        { 章号: 3, 动词: '回收', 证据: 'boom' },
      ]),
    ),
  ).toThrow('boom')
  // SAVEPOINT 回滚：DELETE 未生效，旧履历原样（非半截）
  const loaded = loadLeadFromCache(db, '悬念-001')
  expect(loaded!.履历).toEqual([{ 章号: 1, 动词: '埋下', 证据: '旧证据' }])
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

// 重评-0914-三轮 P3-4 回归：leads 主表 INSERT 已挪进 SAVEPOINT——履历段失败时整段
// 回滚，leads 不留半写（独立调用无 rebuild 整体事务兜底，半不一致此前只在独立调用暴露）。
test('履历段失败 → leads 主表不留半写行（新 lead 无残留）', () => {
  const { db, dir } = makeDb()
  db.exec(
    `CREATE TRIGGER fail_history BEFORE INSERT ON lead_history
     WHEN NEW.evidence = 'boom' BEGIN SELECT RAISE(ABORT, 'boom'); END`,
  )
  // 新 lead（leads 无既有行）：首条履历即触发 ABORT → 整段 SAVEPOINT 回滚，
  // leads 表不得残留「有主表行、无履历」的半写态
  expect(() => syncLead(db, leadOf([{ 章号: 1, 动词: '埋下', 证据: 'boom' }]))).toThrow('boom')
  expect(loadLeadFromCache(db, '悬念-001')).toBeNull()
  expect(db.prepare('SELECT COUNT(*) AS n FROM lead_history').get()).toEqual({ n: 0 })
  db.close()
  rmSync(dir, { recursive: true, force: true })
})
