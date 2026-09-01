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
import { rmSync, existsSync, copyFileSync, mkdirSync, writeFileSync, renameSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
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
  const d = mkdtempTracked(join(tmpdir(), 'f1-migrate-'))
  dirs.push(d)
  return d
}

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

describe('migrateBookSession', () => {
  it('迁移后新名可读到原会话（对话 + 工作区），旧库文件被移走', async () => {
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

    await migrateBookSession(ud, oldRoot, newRoot, '旧名', '新名')

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

  it('userDataPath 为空 → no-op；旧库不存在 → no-op（不抛）', async () => {
    const ud = tmpRoot()
    // R34D-19：migrateBookSession 转异步——not.toThrow 同步口径改 resolves（无拒绝 = 不抛）
    await expect(migrateBookSession(null, '/books/a', '/books/b', 'a', 'b')).resolves.toBe(true)
    await expect(migrateBookSession(ud, '/books/a', '/books/b', 'a', 'b')).resolves.toBe(true)
    // 没建过库 → 无新库文件产生
    expect(existsSync(join(ud, 'clwriting', 'session', bookHash('/books/b') + '.db'))).toBe(false)
  })

  it('连接收口后迁移（R64-8：在途引用不再强迁，引用计数被清零后放行）', async () => {
    const ud = tmpRoot()
    const oldRoot = '/books/甲'
    const newRoot = '/books/乙'
    const store = openSessionStore(ud, oldRoot)!
    const sid = store.createSession('甲')
    store.appendEvents(sid, [{ type: 'user/message', data: { message: 'x' }, surfaceOp: 'append' }])
    // R64-8（十二轮）：refs>0 一律拦截（refs==1 的首个调用方同样是活跃持有者）——收口后再迁
    store.close()

    expect(await migrateBookSession(ud, oldRoot, newRoot, '甲', '乙')).toBe(true)

    const migrated = openSessionStore(ud, newRoot)!
    expect(migrated.listEvents('乙').length).toBeGreaterThan(0)
    migrated.close()
    // 旧连接对象继续 close 不应抛（幂等）
    expect(() => store.close()).not.toThrow()
  })

  it('持锁回归：另一连接 BEGIN EXCLUSIVE 持锁 → 返回 false 且源库原地完整；释放后重迁成功', async () => {
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
    // R64-8（十二轮）：在途引用（refs>0）不再强迁——先收口，持锁路径才可达 checkpoint
    store.close()

    // 另一连接对源库 BEGIN EXCLUSIVE 持锁（模拟跨进程写方/事务未释放）
    const holder = new DatabaseSync(oldDb)
    holder.exec('BEGIN EXCLUSIVE')

    // 持锁迁移：checkpoint 忙 → 整体放弃（false）。此时一个文件都不许动——
    // 主库+侧车原地完整，绝不允许「主库已走、侧车滞留」的半搬状态
    expect(await migrateBookSession(ud, oldRoot, newRoot, '锁甲', '锁乙')).toBe(false)
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
    expect(await migrateBookSession(ud, oldRoot, newRoot, '锁甲', '锁乙')).toBe(true)
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

  // Windows 上 SQLite 的 wal_checkpoint(TRUNCATE) 在「另有连接持有 -wal 文件」时必返
  // busy（NTFS 文件共享语义，无法截断他句柄打开的文件）——迁移按设计 fail-closed 拒绝
  // （checkpoint 忙 → 整体放弃，源库原地完整，无数据丢失方向）。「他连接持库时仍可折叠
  // 迁移」这一守卫语义由 macOS/Linux CI 腿覆盖（J0 win 适配实测定性）
  it.skipIf(process.platform === 'win32')('checkpoint 折叠：未 checkpoint 的写入（唯一副本在 -wal）迁移后新位置完整', async () => {
    const ud = tmpRoot()
    const oldRoot = '/books/折甲'
    const newRoot = '/books/折乙'
    const oldDb = join(ud, 'clwriting', 'session', bookHash(oldRoot) + '.db')
    const newDb = join(ud, 'clwriting', 'session', bookHash(newRoot) + '.db')

    // R64-8（十二轮）：单例连接收口（refs>0 不再强迁）——未 checkpoint 写入改由
    // 旁路裸连接制造：建库写数据 → close（折进主库）→ 裸连接追加新行且不 checkpoint，
    // 新行唯一副本落 -wal；主库单文件拷走只读打开查不到该行，证明副本确在侧车。
    // 迁移若不折叠 WAL 就搬文件（或搬丢侧车），该行即全损
    const store = openSessionStore(ud, oldRoot)!
    const sid = store.createSession('折甲')
    store.appendEvents(sid, [{ type: 'user/message', data: { message: '种子数据' }, surfaceOp: 'append' }])
    store.close()
    const writer = new DatabaseSync(oldDb)
    writer.prepare(
      `INSERT INTO events (session_id, type, data, replace_generation, created_at)
       VALUES (?, 'user/message', ?, 0, ?)`,
    ).run(sid, JSON.stringify({ message: '折叠数据' }), Date.now())
    const mainOnlyCopy = join(ud, 'main-only-copy.db')
    copyFileSync(oldDb, mainOnlyCopy)
    const ro = new DatabaseSync(mainOnlyCopy, { readOnly: true })
    const inMain = ro.prepare("SELECT COUNT(*) AS n FROM events WHERE data LIKE '%折叠数据%'").get() as { n: number }
    expect(inMain.n).toBe(0) // 主库查不到：唯一副本在 -wal
    ro.close()
    rmSync(mainOnlyCopy)

    // 迁移成功：WAL 在搬移前经显式 TRUNCATE 折叠进主库（见 store.ts 5.1-3）——
    // writer 仍开着（跨进程忘关的连接），已提交无持锁 → checkpoint 可折叠
    expect(await migrateBookSession(ud, oldRoot, newRoot, '折甲', '折乙')).toBe(true)
    // 旧位置整体清空（不留孤儿侧车），新位置数据完整、旧钥匙查不到
    expect(existsSync(oldDb)).toBe(false)
    expect(existsSync(oldDb + '-wal')).toBe(false)
    expect(existsSync(oldDb + '-shm')).toBe(false)
    expect(existsSync(newDb)).toBe(true)
    const migrated = openSessionStore(ud, newRoot)!
    // 折叠数据（-wal 唯一副本的那行）在新位置可读
    expect(migrated.listEvents('折乙').some((e) => (e.data as { message?: string }).message === '折叠数据')).toBe(true)
    expect(migrated.listEvents('折甲')).toEqual([])
    migrated.close()
    writer.close()
  })

  it('第十轮 M-1 回归：未关连接的强制迁移必须真关+清缓存，旧路径重开拿到全新空库而非别名已迁走库的僵尸句柄', async () => {
    const ud = tmpRoot()
    // R67-2（十五轮）：改用真实目录路径——墓碑守卫按「旧书根目录是否仍在」分态：
    // 根目录在（同路径重新建书）→ 过期墓碑清除、放行新建空库；本例建模前者。
    // 迁移后 mkdirSync 即「同路径重新建书」动作本身。
    const oldRoot = join(ud, 'books', '僵甲')
    const newRoot = join(ud, 'books', '僵乙')
    const oldDb = join(ud, 'clwriting', 'session', bookHash(oldRoot) + '.db')
    const newDb = join(ud, 'clwriting', 'session', bookHash(newRoot) + '.db')
    mkdirSync(oldRoot, { recursive: true })

    // R64-8（十二轮）：refs=1 不再强迁（N8+R64-8 判定 refs>0 全拦）——收口后再迁。
    // L-5/M-1 的「真关+清缓存」语义由正常 close 承接；本例守「迁移后旧路径重开
    // 必须新建空库，不得经任何残留缓存条目读到已迁走数据」
    const store = openSessionStore(ud, oldRoot)!
    const sid = store.createSession('僵甲')
    store.appendEvents(sid, [{ type: 'user/message', data: { message: '僵尸数据' }, surfaceOp: 'append' }])
    store.close()

    expect(await migrateBookSession(ud, oldRoot, newRoot, '僵甲', '僵乙')).toBe(true)
    expect(existsSync(oldDb)).toBe(false)
    expect(existsSync(newDb)).toBe(true)

    // 同路径重新建书（根目录在位）：过期墓碑清除，重开必须新建空库文件——
    // 缺陷态则复用僵尸条目、不建文件，oldDb 仍不存在
    const reopened = openSessionStore(ud, oldRoot)!
    expect(existsSync(oldDb)).toBe(true)
    // 新库是空库：绝不能透过旧路径读到已迁走的数据
    expect(reopened.listEvents('僵甲')).toEqual([])
    reopened.close()

    // 已迁数据只在新路径、且钥匙是新名；旧 store 句柄事后 close 幂等不抛
    const migrated = openSessionStore(ud, newRoot)!
    expect(migrated.listEvents('僵乙').map((e) => e.type)).toContain('user/message')
    expect(migrated.listEvents('僵甲')).toEqual([])
    migrated.close()
    expect(() => store.close()).not.toThrow()
  })

  it('kk-P2-3 目标位已有库 → 返回 false 放弃（renameSync 静默覆盖防线），两侧数据都不动', async () => {    const ud = tmpRoot()
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
    expect(await migrateBookSession(ud, oldRoot, newRoot, '碰甲', '碰乙')).toBe(false)
    expect(existsSync(oldDb)).toBe(true)
    const probeOld = new DatabaseSync(oldDb)
    expect((probeOld.prepare("SELECT COUNT(*) AS n FROM events WHERE type = 'user/message'").get() as { n: number }).n).toBe(1)
    probeOld.close()
    const probeNew = new DatabaseSync(newDb)
    expect((probeNew.prepare("SELECT COUNT(*) AS n FROM events WHERE type = 'user/message'").get() as { n: number }).n).toBe(1)
    probeNew.close()
  })

  // R32-4（三十二轮）：迁移崩溃窗自愈——「rename 成功、钥匙 UPDATE 未及 COMMIT」的
  // 半迁移态（旧库缺失+墓碑在位+新库在位但两把钥匙仍旧名）此前被早退分支吞掉
  // （return true 永不补跑），对话史/工作区事件视图在新旧两头都查不到（「消失」）。
  it('R32-4: 半迁移态（文件已搬、钥匙未改）重试 → 幂等补跑钥匙 UPDATE，新旧两头恢复可读', async () => {
    const ud = tmpRoot()
    const oldRoot = '/books/愈甲'
    const newRoot = '/books/愈乙'
    const oldDb = join(ud, 'clwriting', 'session', bookHash(oldRoot) + '.db')
    const newDb = join(ud, 'clwriting', 'session', bookHash(newRoot) + '.db')

    // 造数据：对话 + 工作区两把钥匙，收口
    const store = openSessionStore(ud, oldRoot)!
    const chatSid = store.createSession('愈甲')
    store.appendEvents(chatSid, [{ type: 'user/message', data: { message: '崩溃窗数据' }, surfaceOp: 'append' }])
    const wsSid = store.createSession(bookHash(oldRoot))
    store.appendEvents(wsSid, [{ type: 'step/start', data: {} }])
    store.close()

    // 手工构造崩溃窗终态：墓碑已落（3.5）+ 文件已搬（3）+ 钥匙 UPDATE 未 COMMIT（4）
    writeFileSync(oldDb + '.migrated', JSON.stringify({ to: newDb, at: Date.now() }), 'utf-8')
    for (const suffix of ['', '-wal', '-shm'] as const) {
      if (existsSync(oldDb + suffix)) renameSync(oldDb + suffix, newDb + suffix)
    }
    expect(existsSync(oldDb)).toBe(false)
    expect(existsSync(newDb)).toBe(true)
    // 窗内事实：新库钥匙仍旧名——新名下两头都查不到（「消失」形态）
    const half = new DatabaseSync(newDb)
    const oldKeyRows = half.prepare("SELECT COUNT(*) AS n FROM sessions WHERE book = ?").get('愈甲') as { n: number }
    half.close()
    expect(oldKeyRows.n).toBeGreaterThan(0)

    // 作者重试改名到达：早退分支不得吞掉——幂等补跑两条 UPDATE 后自愈
    expect(await migrateBookSession(ud, oldRoot, newRoot, '愈甲', '愈乙')).toBe(true)
    const migrated = openSessionStore(ud, newRoot)!
    expect(migrated.listEvents('愈乙').map((e) => e.type)).toContain('user/message')
    expect(migrated.listEvents(bookHash(newRoot)).length).toBeGreaterThan(0)
    expect(migrated.listEvents('愈甲')).toEqual([])
    expect(migrated.listEvents(bookHash(oldRoot))).toEqual([])
    migrated.close()
  })
})

describe('R66-12/R73-38: 迁移/首开跨进程互斥（per-book migrate-<bookHash>.lock）', () => {
  it('锁被占（模拟另一进程正在迁移/持锁）→ migrate 返回 false 且源库原地完整；释放后重试成功', async () => {
    const ud = tmpRoot()
    const oldRoot = '/books/互斥甲'
    const newRoot = '/books/互斥乙'
    const oldDb = join(ud, 'clwriting', 'session', bookHash(oldRoot) + '.db')
    const newDb = join(ud, 'clwriting', 'session', bookHash(newRoot) + '.db')
    // 造数据并收口（在途引用路径之外的锁路径）
    const store = openSessionStore(ud, oldRoot)!
    const sid = store.createSession('互斥甲')
    store.appendEvents(sid, [{ type: 'user/message', data: { message: '互斥数据' }, surfaceOp: 'append' }])
    store.close()

    __setSessionMigrateLockTimeoutForTest(80) // 缩短锁等待保测试快
    try {
      // 模拟另一进程持锁：锁文件对任何持有者一视同仁（本进程占位同样构成互斥面）
      const release = acquireCrossProcessLockWithTimeout(sessionMigrateLockPath(ud, oldRoot), 1_000)
      expect(release).not.toBeNull()
      // R73-38：锁名掺 bookHash 后持旧书锁即构成迁移互斥面（新旧两把任一被占即放弃）
      // 修复前：无跨进程锁，迁移段照常推进（checkpoint/搬移不被互斥）
      expect(await migrateBookSession(ud, oldRoot, newRoot, '互斥甲', '互斥乙')).toBe(false)
      expect(existsSync(oldDb)).toBe(true) // 源库原地完整
      expect(existsSync(newDb)).toBe(false) // 一个文件都没动
      release!()
      // 释放后重试成功、数据完整
      expect(await migrateBookSession(ud, oldRoot, newRoot, '互斥甲', '互斥乙')).toBe(true)
      expect(existsSync(newDb)).toBe(true)
      const migrated = openSessionStore(ud, newRoot)!
      expect(migrated.listEvents('互斥乙').map((e) => e.type)).toContain('user/message')
      migrated.close()
    } finally {
      __setSessionMigrateLockTimeoutForTest(5_000)
    }
  })

  it('迁移持锁期间他进程首开被阻：openSessionStore 等锁超时上抛、不留半成品库文件；释放后首开成功', async () => {
    const ud = tmpRoot()
    const bookRoot = '/books/互斥丙'
    const dbPath = join(ud, 'clwriting', 'session', bookHash(bookRoot) + '.db')
    __setSessionMigrateLockTimeoutForTest(80)
    try {
      // 模拟迁移进行中（另一进程持 migrate.lock）：此窗口内首开旧库会在旧路径
      // 重建空库或对半搬文件集跑 DDL（撕裂态）——修复前无任何互斥
      const release = acquireCrossProcessLockWithTimeout(sessionMigrateLockPath(ud, bookRoot), 1_000)
      expect(release).not.toBeNull()
      expect(() => openSessionStore(ud, bookRoot)).toThrow(/打开锁获取超时/)
      // 被阻的首开不得留下半成品（库文件未建）
      expect(existsSync(dbPath)).toBe(false)
      release!()
      // 释放后首开成功（锁不滞留）
      const s = openSessionStore(ud, bookRoot)!
      expect(s.dbPath).toBe(dbPath)
      s.close()
    } finally {
      __setSessionMigrateLockTimeoutForTest(5_000)
    }
  })
})
