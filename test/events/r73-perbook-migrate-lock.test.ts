/**
 * R73-38（二十一轮）回归：session 迁移/首开锁按书（bookHash）分把。
 *
 * 此前全局单把 migrate.lock 把所有书的首开段串成全局队头——开书 B 被无关书 A 的
 * 迁移/首开阻塞 5s 即打开失败。修复后锁名掺 bookHash（migrate-<bookHash>.lock）：
 * 1. 他书持锁 → 本书首开/迁移不受阻（核心行为）；
 * 2. 同书旧路径持锁 → 迁移放弃（源库原地完整）；
 * 3. 同书新路径持锁 → 迁移同样放弃（rename 窗口两侧互斥不漏）。
 */
import { describe, expect, it, afterEach } from 'vitest'
import { rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  openSessionStore,
  migrateBookSession,
  bookHash,
  sessionMigrateLockPath,
  __setSessionMigrateLockTimeoutForTest,
} from '../../src/events/store.js'
import { acquireCrossProcessLockWithTimeout } from '../../src/fs/cross-process-lock.js'
import { mkdtempTracked } from '../helpers/temp-dir.js'

const dirs: string[] = []
function tmpRoot(): string {
  const d = mkdtempTracked(join(tmpdir(), 'r73-evlock-'))
  dirs.push(d)
  return d
}

afterEach(() => {
  __setSessionMigrateLockTimeoutForTest(5_000)
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

describe('R73-38 / per-book 迁移锁', () => {
  it('他书持锁 → 本书首开不受阻（不再全局队头）', () => {
    const ud = tmpRoot()
    const bookA = '/books/A'
    const bookB = '/books/B'
    expect(sessionMigrateLockPath(ud, bookA)).not.toBe(sessionMigrateLockPath(ud, bookB))
    __setSessionMigrateLockTimeoutForTest(80)
    // 模拟另一进程持 A 书锁
    const release = acquireCrossProcessLockWithTimeout(sessionMigrateLockPath(ud, bookA), 1_000)
    expect(release).not.toBeNull()
    // B 书首开照常成功（修复前：全局锁被占 → B 打开超时失败）
    const s = openSessionStore(ud, bookB)!
    const sid = s.createSession('B书')
    s.appendEvents(sid, [{ type: 'user/message', data: { message: '并发首开' } }])
    s.close()
    release!()
  })

  it('同书旧路径持锁 → 迁移放弃，源库原地完整；释放后重试成功', () => {
    const ud = tmpRoot()
    const oldRoot = '/books/互斥甲'
    const newRoot = '/books/互斥乙'
    const oldDb = join(ud, 'clwriting', 'session', bookHash(oldRoot) + '.db')
    const newDb = join(ud, 'clwriting', 'session', bookHash(newRoot) + '.db')
    const store = openSessionStore(ud, oldRoot)!
    const sid = store.createSession('互斥甲')
    store.appendEvents(sid, [{ type: 'user/message', data: { message: '数据' } }])
    store.close()

    __setSessionMigrateLockTimeoutForTest(80)
    const release = acquireCrossProcessLockWithTimeout(sessionMigrateLockPath(ud, oldRoot), 1_000)
    expect(release).not.toBeNull()
    expect(migrateBookSession(ud, oldRoot, newRoot, '互斥甲', '互斥乙')).toBe(false)
    expect(existsSync(oldDb)).toBe(true)
    expect(existsSync(newDb)).toBe(false)
    release!()
    expect(migrateBookSession(ud, oldRoot, newRoot, '互斥甲', '互斥乙')).toBe(true)
    const migrated = openSessionStore(ud, newRoot)!
    expect(migrated.listEvents('互斥乙').map((e) => e.type)).toContain('user/message')
    migrated.close()
  })

  it('同书新路径持锁 → 迁移同样放弃（目标位互斥不漏）', () => {
    const ud = tmpRoot()
    const oldRoot = '/books/旧位'
    const newRoot = '/books/新位'
    const oldDb = join(ud, 'clwriting', 'session', bookHash(oldRoot) + '.db')
    const store = openSessionStore(ud, oldRoot)!
    const sid = store.createSession('旧位')
    store.appendEvents(sid, [{ type: 'user/message', data: { message: '数据' } }])
    store.close()

    __setSessionMigrateLockTimeoutForTest(80)
    const release = acquireCrossProcessLockWithTimeout(sessionMigrateLockPath(ud, newRoot), 1_000)
    expect(release).not.toBeNull()
    // 修复前只锁旧路径口径下（若只拿 lock(old)），新位首开与 rename 窗口的互斥会漏；
    // 修复后迁移段新旧两把（hash 排序获取），任一被占即整体放弃
    expect(migrateBookSession(ud, oldRoot, newRoot, '旧位', '新位')).toBe(false)
    expect(existsSync(oldDb)).toBe(true)
    release!()
  })
})
