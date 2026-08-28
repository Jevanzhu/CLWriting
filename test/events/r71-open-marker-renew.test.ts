/**
 * R71-24 / R71-25（十九轮）回归：开口标记 pid 复用防护 + 迁移墓碑前置。
 *
 * - R71-24：活 pid 但标记超龄（续期早已停止）→ 扫描按 pid 复用残留 GC，迁移不再被
 *   无限期误拒；活句柄由续期定时器刷 mtime 保持「新鲜活标记」语义（自愈重写）。
 * - R71-25：墓碑在搬移前预写；迁移失败回滚后旧位完整活库且无墓碑残留。
 */
import { afterAll, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync, statSync, utimesSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openSessionStore, migrateBookSession, bookHash, configureOpenMarkerRenewMs } from '../../src/events/store.js'

const roots: string[] = []
function freshUd(): string {
  const ud = mkdtempSync(join(tmpdir(), 'r71-marker-'))
  roots.push(ud)
  return ud
}
afterAll(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true })
})

/** 一个必活的「他进程」pid：POSIX 下 pid 1（launchd/init）恒活；win 下 pid 4（System）
 *  恒在——pid 1 在 win 无主进程语义（多半不存在，活标记会被误判死 → 拦迁失效假红），
 *  kill(4,0) 即便 EPERM 也被 J7 语义按存活保守放行。J0（win 适配）实测修正。 */
const LIVE_FOREIGN_PID = process.platform === 'win32' ? 4 : 1

describe('R71-24 开口标记 pid 复用防护', () => {
  it('活 pid + 标记超龄（>10min 无续期）→ 视同死残留 GC，迁移放行', () => {
    const ud = freshUd()
    const oldRoot = join(ud, '复用书')
    const newRoot = join(ud, '复用书新')
    const oldDb = join(ud, 'clwriting', 'session', bookHash(oldRoot) + '.db')
    const store = openSessionStore(ud, oldRoot)!
    store.close()
    // 伪造「死进程 pid 被长命进程复用」的等价物：pid 1 恒活，但 mtime 已 11 分钟
    const marker = oldDb + '.open-' + LIVE_FOREIGN_PID
    writeFileSync(marker, JSON.stringify({ pid: LIVE_FOREIGN_PID }), 'utf-8')
    const past = new Date(Date.now() - 11 * 60_000)
    utimesSync(marker, past, past)

    expect(migrateBookSession(ud, oldRoot, newRoot, '复用书', '复用书新')).toBe(true)
    expect(existsSync(marker)).toBe(false) // 超龄残留被 GC
    expect(existsSync(oldDb)).toBe(false)
  })

  it('活 pid + 标记新鲜 → 仍是活标记拦迁（R67-2 语义不回退）', () => {
    const ud = freshUd()
    const oldRoot = join(ud, '活标书')
    const newRoot = join(ud, '活标书新')
    const oldDb = join(ud, 'clwriting', 'session', bookHash(oldRoot) + '.db')
    const store = openSessionStore(ud, oldRoot)!
    store.close()
    const marker = oldDb + '.open-' + LIVE_FOREIGN_PID
    writeFileSync(marker, JSON.stringify({ pid: LIVE_FOREIGN_PID }), 'utf-8')

    expect(migrateBookSession(ud, oldRoot, newRoot, '活标书', '活标书新')).toBe(false)
    expect(existsSync(oldDb)).toBe(true) // 源库原地完整
  })

  it('续期定时器刷 mtime；标记被误删后自愈重写', async () => {
    configureOpenMarkerRenewMs(20)
    try {
      const ud = freshUd()
      const bookRoot = join(ud, '续期书')
      mkdirSync(bookRoot)
      const dbPath = join(ud, 'clwriting', 'session', bookHash(bookRoot) + '.db')
      const marker = dbPath + '.open-' + process.pid

      const store = openSessionStore(ud, bookRoot)!
      expect(existsSync(marker)).toBe(true)
      // 拨回 11 分钟后等一个续期 tick：mtime 恢复新鲜（续期声明「还活着」）
      const past = new Date(Date.now() - 11 * 60_000)
      utimesSync(marker, past, past)
      await new Promise((r) => setTimeout(r, 80))
      const age = Date.now() - Math.floor(statSync(marker).mtimeMs)
      expect(age).toBeLessThan(60_000)

      // 误删自愈：标记文件被外部清理后，下一 tick 重新写出（内容含 pid+bootTime）
      rmSync(marker, { force: true })
      await new Promise((r) => setTimeout(r, 80))
      expect(existsSync(marker)).toBe(true)

      store.close()
      expect(existsSync(marker)).toBe(false) // 真关库照常注销
    } finally {
      configureOpenMarkerRenewMs(30_000)
    }
  })
})

describe('R71-25 墓碑前置与回滚撤碑', () => {
  it('迁移成功：墓碑在位指向新库（前置落位，成功路径不落文件操作）', () => {
    const ud = freshUd()
    const oldRoot = join(ud, '墓甲')
    const newRoot = join(ud, '墓乙')
    const oldDb = join(ud, 'clwriting', 'session', bookHash(oldRoot) + '.db')
    const newDb = join(ud, 'clwriting', 'session', bookHash(newRoot) + '.db')
    const store = openSessionStore(ud, oldRoot)!
    store.close()

    expect(migrateBookSession(ud, oldRoot, newRoot, '墓甲', '墓乙')).toBe(true)
    expect(existsSync(oldDb + '.migrated')).toBe(true)
    expect(existsSync(newDb)).toBe(true)
    expect(existsSync(oldDb)).toBe(false)
  })

  it('改钥匙阶段失败 → 回滚：源库回旧位完整，预写墓碑被撤', () => {
    const ud = freshUd()
    const oldRoot = join(ud, '败甲')
    const newRoot = join(ud, '败乙')
    const oldDb = join(ud, 'clwriting', 'session', bookHash(oldRoot) + '.db')
    const newDb = join(ud, 'clwriting', 'session', bookHash(newRoot) + '.db')
    const store = openSessionStore(ud, oldRoot)!
    const sid = store.createSession('败甲')
    store.appendEvents(sid, [{ type: 'user/message', data: { m: '数据' }, surfaceOp: 'append' }])
    store.close()
    // 让第 4 步 UPDATE 失败：删掉 sessions 表（搬移成功后开新库改钥匙时抛「无此表」）
    const raw = new DatabaseSync(oldDb)
    raw.exec('DROP TABLE sessions')
    raw.close()

    expect(migrateBookSession(ud, oldRoot, newRoot, '败甲', '败乙')).toBe(false)
    expect(existsSync(oldDb)).toBe(true) // 回滚：源库回旧位
    expect(existsSync(newDb)).toBe(false)
    expect(existsSync(oldDb + '.migrated')).toBe(false) // 预写墓碑已撤——旧位是完整活库
  })
})
