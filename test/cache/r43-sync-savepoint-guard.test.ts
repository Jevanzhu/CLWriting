/**
 * R43-18（四十三轮）：SAVEPOINT 回滚对防自身抛错——syncLead 的履历写入失败时，
 * ROLLBACK TO / RELEASE 在 SQLITE_FULL 等自动回亡外层事务（SAVEPOINT 一并销毁）
 * 的场景下抛 "no such savepoint"，会掩蔽原始写错误。加固后原始错误上抛不被掩蔽。
 */
import { describe, expect, it } from 'vitest'
import type { DatabaseSync } from 'node:sqlite'
import { syncLead } from '../../src/cache/sync.js'
import type { Lead } from '../../src/format/types.js'

const lead: Lead = {
  编号: 'L001',
  标题: '测试线索',
  类型: '悬念',
  状态: '进行中',
  开启章: 1,
  履历: [{ 章号: 1, 动词: '埋设', 证据: '第 1 章某段' }],
  _path: '',
}

describe('R43-18: syncLead——SAVEPOINT 回滚对自吞异常，原始写错误上抛', () => {
  it('履历 INSERT SQLITE_FULL（事务自动回亡连销毁 SAVEPOINT）→ 不被 no such savepoint 掩蔽', () => {
    const execCalls: string[] = []
    const db = {
      exec(sql: string): void {
        execCalls.push(sql)
        if (sql === 'ROLLBACK TO sync_lead_history') {
          throw new Error('no such savepoint: sync_lead_history')
        }
      },
      prepare(sql: string): { run: (...a: unknown[]) => unknown } {
        if (sql.includes('INSERT INTO lead_history')) {
          return { run: () => { throw new Error('SQLITE_FULL: database or disk is full') } }
        }
        return { run: () => undefined }
      },
    }

    let caught: unknown
    try {
      syncLead(db as unknown as DatabaseSync, lead)
    } catch (e) {
      caught = e
    }
    const msg = caught instanceof Error ? caught.message : String(caught)
    expect(caught).toBeInstanceOf(Error)
    // 原始写错误在文案里
    expect(msg).toContain('SQLITE_FULL')
    // ROLLBACK TO 自身的 "no such savepoint" 不再掩蔽原始错误
    expect(msg).not.toContain('no such savepoint')
    // 回滚对确实被尝试过（加固是吞异常，不是跳过）
    expect(execCalls).toContain('ROLLBACK TO sync_lead_history')
  })
})
