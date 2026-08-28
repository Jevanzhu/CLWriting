/**
 * R67-2（十五轮）回归：事件库迁移的跨进程「已持有句柄」残余窗口。
 *
 * 三个互补守卫的行为契约：
 * 1) 开口标记 <db>.open-<pid>：openSessionStore 首开登记 / close 归零注销；
 * 2) 迁移扫描：他进程活标记 → 放弃迁移（false，源库原地完整）；死 pid 残留 → GC 后放行；
 * 3) 迁移墓碑 <db>.migrated：旧根目录不在 + 新库活着 → 旧路径首开 fail-closed 拒建
 *    空库；同路径重新建书（根目录在位）或新库已不存在 → 墓碑过期清除放行。
 */
import { describe, expect, it, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync, mkdirSync, readdirSync, writeFileSync, readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openSessionStore, migrateBookSession, bookHash } from '../../src/events/store.js'

function tmpRoot(): string {
  return mkdtempSync(join(tmpdir(), 'r67-2-marker-'))
}

/** 一个必活的「他进程」pid：POSIX 下 pid 1（launchd/init）恒活；win 下 pid 4（System）
 *  恒在——pid 1 在 win 无主进程语义（多半不存在，活标记会被误判死 → 拦迁失效假红），
 *  kill(4,0) 即便 EPERM 也被 J7 语义按存活保守放行。J0（win 适配）实测修正。 */
const LIVE_FOREIGN_PID = process.platform === 'win32' ? 4 : 1

/** 一个必死的 pid：同步跑一个立即退出的子进程取其 pid（返回时已终止）。 */
function deadPid(): number {
  const r = spawnSync(process.execPath, ['-e', ''], { timeout: 10_000 })
  expect(r.status).toBe(0)
  return r.pid!
}

const roots: string[] = []
function freshUd(): string {
  const ud = tmpRoot()
  roots.push(ud)
  return ud
}
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true })
})

describe('R67-2 开口标记生命周期', () => {
  it('首开登记 .open-<pid> 标记，close 归零注销', () => {
    const ud = freshUd()
    const bookRoot = join(ud, '书甲')
    mkdirSync(bookRoot)
    const dbPath = join(ud, 'clwriting', 'session', bookHash(bookRoot) + '.db')

    const store = openSessionStore(ud, bookRoot)!
    expect(existsSync(dbPath + '.open-' + process.pid)).toBe(true)

    store.close()
    expect(existsSync(dbPath + '.open-' + process.pid)).toBe(false)
  })
})

describe('R67-2 迁移扫描：已持有句柄拦迁', () => {
  it('他进程活标记 → 迁移 false、源库原地完整；标记消失后重迁成功', () => {
    const ud = freshUd()
    const oldRoot = join(ud, '旧书')
    const newRoot = join(ud, '新书')
    const oldDb = join(ud, 'clwriting', 'session', bookHash(oldRoot) + '.db')
    const newDb = join(ud, 'clwriting', 'session', bookHash(newRoot) + '.db')

    const store = openSessionStore(ud, oldRoot)!
    const sid = store.createSession('旧名')
    store.appendEvents(sid, [{ type: 'user/message', data: { message: '数据' }, surfaceOp: 'append' }])
    store.close()
    // 伪造他进程活标记（第二个实例/CLI 持旧库句柄的等价物）
    writeFileSync(oldDb + '.open-' + LIVE_FOREIGN_PID, JSON.stringify({ pid: LIVE_FOREIGN_PID }), 'utf-8')

    expect(migrateBookSession(ud, oldRoot, newRoot, '旧名', '新名')).toBe(false)
    expect(existsSync(oldDb)).toBe(true) // 源库原地完整
    expect(existsSync(newDb)).toBe(false)

    rmSync(oldDb + '.open-' + LIVE_FOREIGN_PID, { force: true }) // 他进程收口
    expect(migrateBookSession(ud, oldRoot, newRoot, '旧名', '新名')).toBe(true)
    expect(existsSync(oldDb)).toBe(false)
    expect(existsSync(newDb)).toBe(true)
  })

  it('死 pid 崩溃残留标记 → 扫描时 GC，迁移照常成功', () => {
    const ud = freshUd()
    const oldRoot = join(ud, '崩书')
    const newRoot = join(ud, '崩书新')
    const oldDb = join(ud, 'clwriting', 'session', bookHash(oldRoot) + '.db')
    const stale = oldDb + '.open-' + deadPid()
    const store = openSessionStore(ud, oldRoot)!
    store.close()
    writeFileSync(stale, JSON.stringify({ pid: 'gone' }), 'utf-8')

    expect(migrateBookSession(ud, oldRoot, newRoot, '崩书', '崩书新')).toBe(true)
    expect(existsSync(stale)).toBe(false) // 被 GC
    expect(existsSync(join(ud, 'clwriting', 'session', bookHash(newRoot) + '.db'))).toBe(true)
  })
})

describe('R67-2 迁移墓碑', () => {
  it('迁移成功后旧位落墓碑（内容指向新库）', () => {
    const ud = freshUd()
    const oldRoot = join(ud, '墓书')
    const newRoot = join(ud, '墓书新')
    const oldDb = join(ud, 'clwriting', 'session', bookHash(oldRoot) + '.db')
    const newDb = join(ud, 'clwriting', 'session', bookHash(newRoot) + '.db')
    const store = openSessionStore(ud, oldRoot)!
    store.close()
    // 旧根目录移除（改名搬走的等价物——墓碑拒建分支按「旧根不在」判态）
    expect(migrateBookSession(ud, oldRoot, newRoot, '墓书', '墓书新')).toBe(true)
    expect(existsSync(oldDb + '.migrated')).toBe(true)
    expect((JSON.parse(readFileSync(oldDb + '.migrated', 'utf-8')) as { to: string }).to).toBe(newDb)
  })

  it('旧根目录不在 + 新库活着 → 旧路径迟来首开 fail-closed 拒建空库', () => {
    const ud = freshUd()
    const oldRoot = join(ud, '迁走书')
    const newRoot = join(ud, '迁去书')
    const oldDb = join(ud, 'clwriting', 'session', bookHash(oldRoot) + '.db')
    const store = openSessionStore(ud, oldRoot)!
    store.close()
    expect(migrateBookSession(ud, oldRoot, newRoot, '迁走书', '迁去书')).toBe(true)

    // stale 视图进程迟来首开：旧根不存在（未重建），新库在位 → 拒绝且不建空库文件
    expect(() => openSessionStore(ud, oldRoot)!).toThrow(/已随书改名迁移/)
    expect(existsSync(oldDb)).toBe(false)
  })

  it('同路径重新建书（旧根目录在位）→ 墓碑过期清除，放行新建空库', () => {
    const ud = freshUd()
    const oldRoot = join(ud, '回锅书')
    const newRoot = join(ud, '回锅书新')
    const oldDb = join(ud, 'clwriting', 'session', bookHash(oldRoot) + '.db')
    const store = openSessionStore(ud, oldRoot)!
    store.close()
    expect(migrateBookSession(ud, oldRoot, newRoot, '回锅书', '回锅书新')).toBe(true)

    mkdirSync(oldRoot, { recursive: true }) // 同路径重新建书
    const reopened = openSessionStore(ud, oldRoot)!
    expect(existsSync(oldDb)).toBe(true) // 新建空库
    expect(reopened.listEvents('回锅书')).toEqual([])
    expect(existsSync(oldDb + '.migrated')).toBe(false) // 墓碑已清
    reopened.close()
  })

  it('墓碑指向的新库已不存在（再迁移/删书）→ 过期清除放行', () => {
    const ud = freshUd()
    const oldRoot = join(ud, '链书')
    const midRoot = join(ud, '链书中')
    const farRoot = join(ud, '链书远')
    const oldDb = join(ud, 'clwriting', 'session', bookHash(oldRoot) + '.db')
    const store = openSessionStore(ud, oldRoot)!
    store.close()
    expect(migrateBookSession(ud, oldRoot, midRoot, '链书', '链书中')).toBe(true)
    // 再迁一次：中位 → 远位（中位墓碑随之落，旧位墓碑的目标=中位库已不在）
    expect(migrateBookSession(ud, midRoot, farRoot, '链书中', '链书远')).toBe(true)

    // 旧位首开：旧根不在，但墓碑目标（中位库）也没了 → 过期放行（清墓碑建新库）
    const reopened = openSessionStore(ud, oldRoot)!
    expect(existsSync(oldDb)).toBe(true)
    reopened.close()
  })

  it('书改回旧名（A→B→A）：目标位历史墓碑被迁移清除，不留孤儿墓碑', () => {
    const ud = freshUd()
    const rootA = join(ud, '甲书')
    const rootB = join(ud, '乙书')
    const dbA = join(ud, 'clwriting', 'session', bookHash(rootA) + '.db')
    const store = openSessionStore(ud, rootA)!
    store.close()
    expect(migrateBookSession(ud, rootA, rootB, '甲书', '乙书')).toBe(true)
    expect(existsSync(dbA + '.migrated')).toBe(true)
    expect(migrateBookSession(ud, rootB, rootA, '乙书', '甲书')).toBe(true)
    // A 位重新成为活库位：墓碑被清，库文件在位
    expect(existsSync(dbA)).toBe(true)
    expect(existsSync(dbA + '.migrated')).toBe(false)
    // 且 B 位此刻落了自己的墓碑（数据已离开 B）
    expect(existsSync(join(ud, 'clwriting', 'session', bookHash(rootB) + '.db' + '.migrated'))).toBe(true)
    // 目录里无 .open- 残留（收口干净）
    expect(readdirSync(join(ud, 'clwriting', 'session')).some((n) => n.includes('.open-'))).toBe(false)
  })
})
