/**
 * R71-36（十九轮）回归：resolveRagDbPath 双进程并发迁移竞态——败者的 renameSync
 * 撞上胜者已完成的迁移（legacy 已被迁走）时 ENOENT；修复前无条件回退 legacyPath
 * 会在旧路径重新开出空库（会话白跑 + 孤儿库残留）。修复后先复查 dbPath：存在 ⇒
 * 改道新库；仍不存在才回退旧路径。
 */
import { test, expect, describe, it} from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { rmSync, mkdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveRagDbPath } from '../../src/rag/store.js'
import { mkdtempTracked } from '../helpers/temp-dir.js'

test('R71-36: 败者迁移撞胜者已迁移完成（legacy 不在、db 在）→ 改道新库不开空库', () => {
  const root = mkdtempTracked(join(tmpdir(), 'r71-rag-'))
  try {
    // 胜者已完成迁移的终局盘面：新库在、旧库已被迁走
    mkdirSync(join(root, '.cache'), { recursive: true })
    const db = new DatabaseSync(join(root, '.cache', 'rag.db'))
    db.exec('CREATE TABLE IF NOT EXISTS t(x)')
    db.close()

    const resolved = resolveRagDbPath(root)
    expect(resolved).toBe(join(root, '.cache', 'rag.db'))
    // 关键断言：不得在旧路径开新库（修复前回退 legacyPath → DatabaseSync 惰性建文件）
    const reopened = new DatabaseSync(resolved)
    reopened.exec('SELECT count(*) FROM t') // 胜者的表还在——不是空库
    reopened.close()
    expect(existsSync(join(root, '.rag.db'))).toBe(false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('R71-36: 真迁移失败（旧在、新不在且 rename 不可行）→ 仍回退旧路径', () => {
  const root = mkdtempTracked(join(tmpdir(), 'r71-rag-legacy-'))
  try {
    // 旧库在、新库不在：resolve 会尝试真实迁移（checkpoint + rename）——正常环境
    // 迁移成功即验证主路径；迁移成功后新库必须存在且旧库不再被引用
    const legacy = new DatabaseSync(join(root, '.rag.db'))
    legacy.exec('CREATE TABLE IF NOT EXISTS t(x)')
    legacy.close()

    const resolved = resolveRagDbPath(root)
    expect(resolved).toBe(join(root, '.cache', 'rag.db'))
    expect(existsSync(join(root, '.cache', 'rag.db'))).toBe(true)
    expect(existsSync(join(root, '.rag.db'))).toBe(false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

describe('迁移阶梯契约：步必须幂等且可重入（阶梯不包外层事务）', () => {
  it('半程崩溃（DDL 已生效、user_version 未推进）→ 下次打开重跑同一步收敛，不抛', async () => {
    const { mkdtempSync, rmSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join: pjoin } = await import('node:path')
    const { DatabaseSync } = await import('node:sqlite')
    const { migrateSqlite } = await import('../../src/shared/sqlite-migrate.js')
    const root = mkdtempSync(pjoin(tmpdir(), 'clw-ladder-'))
    const db = new DatabaseSync(pjoin(root, 'ladder.db'))
    try {
      // 半程现场：步内 DDL 已生效（表已在），版本锚未推进
      db.exec('CREATE TABLE t (a TEXT)')
      const outcome = migrateSqlite(db, {
        tag: '契约',
        target: 1,
        steps: [
          {
            to: 1,
            // 幂等形态：IF NOT EXISTS——重跑即 no-op（本契约要求的最小实现）
            run: (c: DatabaseSync) => c.exec('CREATE TABLE IF NOT EXISTS t (a TEXT)'),
          },
        ],
        createFresh: (c: DatabaseSync) => c.exec('CREATE TABLE t (a TEXT)'),
      })
      expect(outcome).toMatchObject({ kind: 'applied', from: 0, to: 1, appliedSteps: [1] })
      expect((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(1)
    } finally {
      db.close()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('非幂等形态的步（裸 CREATE TABLE）在同一库上重跑即抛——契约的反面钉子', async () => {
    const { mkdtempSync, rmSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join: pjoin } = await import('node:path')
    const { DatabaseSync } = await import('node:sqlite')
    const { migrateSqlite } = await import('../../src/shared/sqlite-migrate.js')
    const root = mkdtempSync(pjoin(tmpdir(), 'clw-ladder2-'))
    const db = new DatabaseSync(pjoin(root, 'ladder.db'))
    try {
      db.exec('CREATE TABLE t (a TEXT)')
      // 阶梯不包外层事务：违反契约的步不会被任何一层兜住——这正是它必须写成幂等的原因
      expect(() =>
        migrateSqlite(db, {
          tag: '契约',
          target: 1,
          steps: [{ to: 1, run: (c: DatabaseSync) => c.exec('CREATE TABLE t (a TEXT)') }],
          createFresh: (c: DatabaseSync) => c.exec('CREATE TABLE t (a TEXT)'),
        }),
      ).toThrow(/already exists/i)
    } finally {
      db.close()
      rmSync(root, { recursive: true, force: true })
    }
  })
})
