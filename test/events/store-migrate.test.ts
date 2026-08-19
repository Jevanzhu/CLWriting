/**
 * 改书事件库迁移单测：migrateBookSession 把旧 hash DB → 新 hash DB，
 * 并把会话 book 字段改名（对话 book=旧名 → 新名、工作区 book=旧 hash → 新 hash）。
 * no-op 语义：失败/无库不抛、不产生新库文件。
 *
 * 5.1-3 回归：迁移前先 checkpoint(TRUNCATE) 折叠 WAL——未 checkpoint 的写入
 * （唯一副本在 -wal）迁移后新位置完整；checkpoint 忙（另一连接持锁）或任一步
 * 失败 → 返回 false 整体放弃，源库主库+侧车原地完整，绝不半搬。
 */
import { describe, expect, it, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync, copyFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openSessionStore, migrateBookSession, bookHash } from '../../src/events/store.js'

const dirs: string[] = []
function tmpRoot(): string {
  const d = mkdtempSync(join(tmpdir(), 'f1-migrate-'))
  dirs.push(d)
  return d
}

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

describe('migrateBookSession', () => {
  it('迁移后新名可读到原会话（对话 + 工作区），旧库文件被移走', () => {
    const ud = tmpRoot()
    const oldRoot = '/books/旧名'
    const newRoot = '/books/新名'
    const oldDb = join(ud, 'clwriting', 'session', bookHash(oldRoot) + '.db')
    const newDb = join(ud, 'clwriting', 'session', bookHash(newRoot) + '.db')

    // 造数据：对话会话 book=旧名 + 工作区会话 book=bookHash(oldRoot)
    const store = openSessionStore(ud, oldRoot)!
    const chatSid = store.createSession('旧名')
    store.appendEvents(chatSid, [{ type: 'user/message', data: { message: '你好' }, surfaceOp: 'append' }])
    const wsSid = store.createSession(bookHash(oldRoot))
    store.appendEvents(wsSid, [{ type: 'step/start', data: {} }])
    store.close()
    expect(existsSync(oldDb)).toBe(true)
    expect(existsSync(newDb)).toBe(false)

    migrateBookSession(ud, oldRoot, newRoot, '旧名', '新名')

    // 旧库文件已移走、新库文件出现
    expect(existsSync(oldDb)).toBe(false)
    expect(existsSync(newDb)).toBe(true)
    // 新名可读到迁移后的对话 + 工作区会话
    const migrated = openSessionStore(ud, newRoot)!
    const chatEvs = migrated.listEvents('新名')
    expect(chatEvs.map((e) => e.type)).toContain('user/message')
    expect(migrated.listEvents(bookHash(newRoot)).length).toBeGreaterThan(0)
    // 旧名/旧 hash 查不到（book 字段已改）
    expect(migrated.listEvents('旧名')).toEqual([])
    expect(migrated.listEvents(bookHash(oldRoot))).toEqual([])
    migrated.close()
  })

  it('userDataPath 为空 → no-op；旧库不存在 → no-op（不抛）', () => {
    const ud = tmpRoot()
    expect(() => migrateBookSession(null, '/books/a', '/books/b', 'a', 'b')).not.toThrow()
    expect(() => migrateBookSession(ud, '/books/a', '/books/b', 'a', 'b')).not.toThrow()
    // 没建过库 → 无新库文件产生
    expect(existsSync(join(ud, 'clwriting', 'session', bookHash('/books/b') + '.db'))).toBe(false)
  })

  it('旧库缓存连接未关闭时也能强制迁移（引用计数被清零）', () => {
    const ud = tmpRoot()
    const oldRoot = '/books/甲'
    const newRoot = '/books/乙'
    // 不 close：模拟仍有引用在手的场景
    const store = openSessionStore(ud, oldRoot)!
    const sid = store.createSession('甲')
    store.appendEvents(sid, [{ type: 'user/message', data: { message: 'x' }, surfaceOp: 'append' }])

    migrateBookSession(ud, oldRoot, newRoot, '甲', '乙')

    const migrated = openSessionStore(ud, newRoot)!
    expect(migrated.listEvents('乙').length).toBeGreaterThan(0)
    migrated.close()
    // 旧连接对象继续 close 不应抛（幂等）
    expect(() => store.close()).not.toThrow()
  })

  it('持锁回归：另一连接 BEGIN EXCLUSIVE 持锁 → 返回 false 且源库原地完整；释放后重迁成功', () => {
    const ud = tmpRoot()
    const oldRoot = '/books/锁甲'
    const newRoot = '/books/锁乙'
    const oldDb = join(ud, 'clwriting', 'session', bookHash(oldRoot) + '.db')
    const newDb = join(ud, 'clwriting', 'session', bookHash(newRoot) + '.db')

    // 造数据且连接保持打开（缓存未关）：提交的事务留在 -wal 未 checkpoint——
    // 正是评审 5.1-3 里「侧车一丢、事务全损」最脆弱的窗口
    const store = openSessionStore(ud, oldRoot)!
    const sid = store.createSession('锁甲')
    store.appendEvents(sid, [{ type: 'user/message', data: { message: '持锁数据' }, surfaceOp: 'append' }])

    // 另一连接对源库 BEGIN EXCLUSIVE 持锁（模拟跨进程写方/事务未释放）
    const holder = new DatabaseSync(oldDb)
    holder.exec('BEGIN EXCLUSIVE')

    // 持锁迁移：checkpoint 忙 → 整体放弃（false）。此时一个文件都不许动——
    // 主库+侧车原地完整，绝不允许「主库已走、侧车滞留」的半搬状态
    expect(migrateBookSession(ud, oldRoot, newRoot, '锁甲', '锁乙')).toBe(false)
    expect(existsSync(oldDb)).toBe(true)
    expect(existsSync(oldDb + '-wal')).toBe(true)
    expect(existsSync(oldDb + '-shm')).toBe(true)
    expect(existsSync(newDb)).toBe(false)
    // 源库数据可读无丢失（WAL 模式读方与持锁写方共存；数据可能仍只在 -wal 里）
    const probe = new DatabaseSync(oldDb)
    const cnt = probe.prepare("SELECT COUNT(*) AS n FROM events WHERE type = 'user/message'").get() as { n: number }
    expect(cnt.n).toBe(1)
    probe.close()

    // 释放锁后再迁 → 成功且数据完整、对话钥匙已改成新名
    holder.exec('ROLLBACK')
    holder.close()
    expect(migrateBookSession(ud, oldRoot, newRoot, '锁甲', '锁乙')).toBe(true)
    expect(existsSync(oldDb)).toBe(false)
    expect(existsSync(oldDb + '-wal')).toBe(false)
    expect(existsSync(newDb)).toBe(true)
    const migrated = openSessionStore(ud, newRoot)!
    expect(migrated.listEvents('锁乙').map((e) => e.type)).toContain('user/message')
    expect(migrated.listEvents('锁甲')).toEqual([])
    migrated.close()
    // 持锁路径下被 migrate 强制关掉的缓存连接，事后 close 幂等不抛
    expect(() => store.close()).not.toThrow()
  }, 30_000)

  it('checkpoint 折叠：未 checkpoint 的写入（唯一副本在 -wal）迁移后新位置完整', () => {
    const ud = tmpRoot()
    const oldRoot = '/books/折甲'
    const newRoot = '/books/折乙'
    const oldDb = join(ud, 'clwriting', 'session', bookHash(oldRoot) + '.db')
    const newDb = join(ud, 'clwriting', 'session', bookHash(newRoot) + '.db')

    // 连接保持打开（缓存未关）→ DDL+数据全部提交进 -wal，主库文件仍是空库：
    // 把主库单文件拷走以只读打开验证——连 events 表都不存在，证明唯一数据副本
    // 在侧车里；迁移若不折叠 WAL 就搬文件（或搬丢侧车），数据即全损
    const store = openSessionStore(ud, oldRoot)!
    const sid = store.createSession('折甲')
    store.appendEvents(sid, [{ type: 'user/message', data: { message: '折叠数据' }, surfaceOp: 'append' }])
    const mainOnlyCopy = join(ud, 'main-only-copy.db')
    copyFileSync(oldDb, mainOnlyCopy)
    const ro = new DatabaseSync(mainOnlyCopy, { readOnly: true })
    const schema = ro.prepare('SELECT COUNT(*) AS n FROM sqlite_master').get() as { n: number }
    expect(schema.n).toBe(0)
    ro.close()
    rmSync(mainOnlyCopy)

    // 迁移成功：WAL 在搬移前被折叠进主库（无论折叠落在强制关连接的 close
    // checkpoint 还是显式 TRUNCATE，动手搬文件前必已完成——见 store.ts 5.1-3）
    expect(migrateBookSession(ud, oldRoot, newRoot, '折甲', '折乙')).toBe(true)
    // 旧位置整体清空（不留孤儿侧车），新位置数据完整、旧钥匙查不到
    expect(existsSync(oldDb)).toBe(false)
    expect(existsSync(oldDb + '-wal')).toBe(false)
    expect(existsSync(oldDb + '-shm')).toBe(false)
    expect(existsSync(newDb)).toBe(true)
    const migrated = openSessionStore(ud, newRoot)!
    expect(migrated.listEvents('折乙').map((e) => e.type)).toContain('user/message')
    expect(migrated.listEvents('折甲')).toEqual([])
    migrated.close()
  })

  it('kk-P2-3 目标位已有库 → 返回 false 放弃（renameSync 静默覆盖防线），两侧数据都不动', () => {
    const ud = tmpRoot()
    const oldRoot = '/books/碰甲'
    const newRoot = '/books/碰乙'
    const oldDb = join(ud, 'clwriting', 'session', bookHash(oldRoot) + '.db')
    const newDb = join(ud, 'clwriting', 'session', bookHash(newRoot) + '.db')

    // 源库有数据；目标位已有同名库（hash 碰撞/旧书残库场景），里面有一条不同数据
    const store = openSessionStore(ud, oldRoot)!
    const sid = store.createSession('碰甲')
    store.appendEvents(sid, [{ type: 'user/message', data: { message: '源库数据' }, surfaceOp: 'append' }])
    store.close()
    const target = openSessionStore(ud, newRoot)!
    const tsid = target.createSession('碰乙')
    target.appendEvents(tsid, [{ type: 'user/message', data: { message: '目标库数据' }, surfaceOp: 'append' }])
    target.close()
    expect(existsSync(newDb)).toBe(true)

    // 迁移放弃（false），绝不覆盖目标位
    expect(migrateBookSession(ud, oldRoot, newRoot, '碰甲', '碰乙')).toBe(false)
    expect(existsSync(oldDb)).toBe(true)
    const probeOld = new DatabaseSync(oldDb)
    expect((probeOld.prepare("SELECT COUNT(*) AS n FROM events WHERE type = 'user/message'").get() as { n: number }).n).toBe(1)
    probeOld.close()
    const probeNew = new DatabaseSync(newDb)
    expect((probeNew.prepare("SELECT COUNT(*) AS n FROM events WHERE type = 'user/message'").get() as { n: number }).n).toBe(1)
    probeNew.close()
  })
})
