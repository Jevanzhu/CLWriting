/**
 * R43-18（四十三轮）：ROLLBACK 防自身抛错回归——六处加固中最小可行的两处代表验证：
 * SQLite 部分错误（SQLITE_FULL/IOERR 等）已自动回亡事务时，裸 ROLLBACK 抛
 * "no transaction is active" 会掩蔽原始写错误；加固后原始错误上抛不被掩蔽。
 *
 * - resetRagIndex（rag/index.ts）：经 mock openRagDb 注入故障 db（index.ts 的四 处
 *   加固同一模板，取清库事务为代表）
 * - ensureNormColumn（rag/store.ts）：函数收 db 形参，直接喂故障 db
 * SAVEPOINT 回滚对（cache/sync.ts syncLead）见 test/cache/r43-sync-savepoint-guard.test.ts
 */
import { describe, expect, it, vi } from 'vitest'
import type { DatabaseSync } from 'node:sqlite'

const openRagDbMock = vi.fn()

vi.mock('../../src/rag/store.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../src/rag/store.js')>()
  return { ...orig, openRagDb: (...args: Parameters<typeof orig.openRagDb>) => openRagDbMock(...args) }
})

// vi.mock 提升语义下 import 后置是库内既定形态（r38-migrate-tombstone 先例）
import { resetRagIndex } from '../../src/rag/index.js'
import { ensureNormColumn } from '../../src/rag/store.js'

const ROLLBACK_SELF_ERR = 'no transaction is active'

describe('R43-18: resetRagIndex——ROLLBACK 自身抛错不掩蔽原始写错误', () => {
  it('DELETE 阶段 SQLITE_FULL（事务已自动回亡）→ ROLLBACK 抛错被吞，原始错误上抛', () => {
    const execCalls: string[] = []
    const db = {
      exec(sql: string): void {
        execCalls.push(sql)
        if (sql === 'DELETE FROM chunks') throw new Error('SQLITE_FULL: database or disk is full')
        if (sql === 'ROLLBACK') throw new Error(`SQLite error: ${ROLLBACK_SELF_ERR}`)
      },
      close(): void {},
    }
    openRagDbMock.mockReturnValue(db)

    let caught: unknown
    try {
      resetRagIndex('/fixtures/any-book')
    } catch (e) {
      caught = e
    }
    const msg = caught instanceof Error ? caught.message : String(caught)
    expect(caught).toBeInstanceOf(Error)
    // 原始写错误在文案里
    expect(msg).toContain('SQLITE_FULL')
    // ROLLBACK 自身的 "no transaction is active" 不再顶替/掩蔽原始错误
    expect(msg).not.toContain(ROLLBACK_SELF_ERR)
    // ROLLBACK 确实被尝试过（加固是吞异常，不是跳过）
    expect(execCalls).toContain('ROLLBACK')
  })
})

describe('R43-18: ensureNormColumn——norm 回填事务同款加固', () => {
  it('UPDATE 阶段 SQLITE_IOERR（事务已自动回亡）→ 原始错误原样上抛', () => {
    const db = {
      exec(sql: string): void {
        if (sql === 'ROLLBACK') throw new Error(`SQLite error: ${ROLLBACK_SELF_ERR}`)
      },
      prepare(sql: string): { all?: () => unknown[]; iterate?: () => Iterable<{ id: number; embedding: Uint8Array }>; run?: (...a: unknown[]) => unknown } {
        if (sql.startsWith('PRAGMA table_info')) return { all: () => [{ name: 'norm' }] }
        // R46-51：SELECT 改游标 iterate 逐行后，mock 语句形态同步（数组本身可迭代）
        if (sql.includes('SELECT id, embedding')) return { iterate: () => [{ id: 1, embedding: new Uint8Array(8) }] }
        if (sql.startsWith('UPDATE chunks SET norm')) {
          return { run: () => { throw new Error('SQLITE_IOERR: disk I/O error') } }
        }
        throw new Error(`unexpected prepare: ${sql}`)
      },
      close(): void {},
    }

    let caught: unknown
    try {
      ensureNormColumn(db as unknown as DatabaseSync)
    } catch (e) {
      caught = e
    }
    const msg = caught instanceof Error ? caught.message : String(caught)
    expect(caught).toBeInstanceOf(Error)
    expect(msg).toContain('SQLITE_IOERR')
    expect(msg).not.toContain(ROLLBACK_SELF_ERR)
  })
})
