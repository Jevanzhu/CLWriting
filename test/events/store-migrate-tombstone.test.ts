/**
 * 事件库改名迁移的墓碑（tombstone）与 rename 退避——数据安全面回归。
 *
 * 三个防线口径：
 * - 搬移/回滚收编 renameWithRetry（R38-1，三十八轮）：win 杀软/索引器瞬时锁（EPERM）
 *   下裸 rename 会打断搬移与回滚；回滚存在失败项时**保留墓碑**（旧位 .db 与 .migrated
 *   双缺会让迟来首开按「正常缺库」重建空库、事件流分裂）。
 * - 墓碑原子写（R41-11，四十一轮）：裸 writeFileSync 写中途进程死会留半截 JSON，消费侧
 *   把解析失败当「无指向」清除放行；现写侧 atomicWriteFile（要么完整要么不在），消费侧
 *   不可解析墓碑保留 + fail-closed 抛错拒建空库。
 * - 墓碑前置到搬移之前（R71-25，十九轮）：闭合「钥匙已改 → 碑未落」的崩溃窗口。
 *
 * 夹具注记：侧车文件在首个 rename 调用时懒创建——迁移前置的 checkpoint(TRUNCATE) 会把
 * 垃圾字节 -wal 清掉/置零，真实 WAL 在 close 时即被折叠删除，无法预先占位。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdtempTracked } from '../helpers/temp-dir.js'

const failState = vi.hoisted(() => ({
  /** 命中即抛 EPERM；`permanent` = 不自动放行（重试耗尽形态），否则一次性瞬时锁形态。 */
  failWhen: null as ((from: string, to: string) => boolean) | null,
  permanent: false,
  /** 首个 rename（主库搬移）时懒创建的侧车占位路径（null = 不造侧车）。 */
  lazySidecarFor: null as string | null,
  /** 目标为墓碑路径（*.migrated）时永久 EPERM——模拟墓碑原子写的 rename 段不可成。 */
  failTombstoneRename: false,
}))
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    renameSync: (from: string, to: string) => {
      if (failState.lazySidecarFor !== null) {
        writeFileSync(failState.lazySidecarFor, 'sidecar')
        failState.lazySidecarFor = null
      }
      if (failState.failTombstoneRename && to.endsWith('.migrated')) {
        throw Object.assign(new Error(`EPERM: operation not permitted, rename '${from}' -> '${to}'`), { code: 'EPERM' })
      }
      if (failState.failWhen?.(from, to)) {
        if (!failState.permanent) failState.failWhen = null // 瞬时锁形态：一次后放行
        throw Object.assign(new Error(`EPERM: operation not permitted, rename '${from}' -> '${to}'`), { code: 'EPERM' })
      }
      return actual.renameSync(from, to)
    },
  }
})

import { migrateBookSession, openSessionStore, bookHash } from '../../src/events/store.js'

const dirs: string[] = []
function tmpRoot(): string {
  const d = mkdtempTracked(join(tmpdir(), 'f1-r38-migrate-'))
  dirs.push(d)
  return d
}

afterEach(() => {
  failState.failWhen = null
  failState.permanent = false
  failState.lazySidecarFor = null
  failState.failTombstoneRename = false
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

/** 造一本有会话数据的旧库（openSessionStore 单源，含 sessions 表），返回路径。 */
function seedOldDb(ud: string, oldRoot: string) {
  const dir = join(ud, 'clwriting', 'session')
  const oldDb = join(dir, bookHash(oldRoot) + '.db')
  const store = openSessionStore(ud, oldRoot)!
  const sid = store.createSession('旧名')
  store.appendEvents(sid, [{ type: 'user/message', data: { message: '你好' }, surfaceOp: 'append' }])
  store.close()
  return { dir, oldDb, newDb: join(dir, bookHash(oldRoot + '-new') + '.db') }
}

describe('R38-1：事件库迁移 rename 退避与墓碑保留', () => {
  it('瞬时 EPERM 一次 → renameWithRetry 退避后迁移完成（主库落新位、钥匙已改）', async () => {
    const ud = tmpRoot()
    const oldRoot = '/books/旧名'
    const { oldDb, newDb } = seedOldDb(ud, oldRoot)
    failState.failWhen = (from) => from === oldDb // 只拦搬移方向第一次

    await expect(migrateBookSession(ud, oldRoot, oldRoot + '-new', '旧名', '新名')).resolves.toBe(true)

    expect(existsSync(oldDb)).toBe(false)
    expect(existsSync(newDb)).toBe(true)
    // R71-25 设计口径：成功路径旧位墓碑保留（记录迁移史；墓碑分支只在 .db 缺失时生效，
    // 碑 + 旧位无 .db 并存无害）——断言的恰是「不撤碑」语义，与回滚失败保留碑共用分支面
    expect(existsSync(oldDb + '.migrated')).toBe(true)
  })

  it('侧车永久失败 + 回滚成功 → 墓碑撤除、旧位主库完整回位（可重试）', async () => {
    const ud = tmpRoot()
    const oldRoot = '/books/旧名'
    const { oldDb, newDb } = seedOldDb(ud, oldRoot)
    failState.permanent = true
    failState.lazySidecarFor = oldDb + '-wal' // 主库搬移时造出侧车 → 下一搬移命中
    failState.failWhen = (from) => from.endsWith('-wal') // 搬移第 2 步重试耗尽

    await expect(migrateBookSession(ud, oldRoot, oldRoot + '-new', '旧名', '新名')).resolves.toBe(false)

    expect(existsSync(oldDb)).toBe(true) // 回滚成功：主库回旧位
    expect(existsSync(newDb)).toBe(false)
    expect(existsSync(oldDb + '.migrated')).toBe(false) // 回滚完整 → 碑照常撤
    expect(existsSync(oldDb + '-wal')).toBe(true) // 侧车原地保留（原样失败语义）
  })

  it('回滚也不可成 → 墓碑保留（迟来首开 fail-closed 拒建空库，事件流不再分裂）', async () => {
    const ud = tmpRoot()
    const oldRoot = '/books/旧名'
    const { oldDb, newDb } = seedOldDb(ud, oldRoot)
    failState.permanent = true
    failState.lazySidecarFor = oldDb + '-wal'
    // 搬移段：-wal 永久失败；回滚段：主库反向 rename（from=新位主库）永久失败
    failState.failWhen = (from, to) => from.endsWith('-wal') || (from === newDb && to === oldDb)

    await expect(migrateBookSession(ud, oldRoot, oldRoot + '-new', '旧名', '新名')).resolves.toBe(false)

    expect(existsSync(oldDb)).toBe(false) // 回滚失败：主库滞留新位（孤儿但数据在）
    expect(existsSync(newDb)).toBe(true)
    // 修复点：墓碑保留——迟来首开旧路径走墓碑分支 fail-closed，不再按缺库重建空库
    expect(existsSync(oldDb + '.migrated')).toBe(true)
  })

  it('墓碑预写不可发布（rename 段永久失败）→ 墓碑要么完整要么不在、整体放弃且源库原地完整', async () => {
    const ud = tmpRoot()
    const oldRoot = '/books/旧名'
    const { dir, oldDb, newDb } = seedOldDb(ud, oldRoot)
    failState.failTombstoneRename = true // 墓碑原子写的 publish 段不可成（裸写形态不经过 rename）

    await expect(migrateBookSession(ud, oldRoot, oldRoot + '-new', '旧名', '新名')).resolves.toBe(false)

    // 原子写失败不留半截碑（裸 writeFileSync 形态会留下完整/半截碑 → 本臂变红）
    expect(existsSync(oldDb + '.migrated')).toBe(false)
    // 预写失败 = 一个文件都还没动 → 整体放弃，源库原地完整可重试
    expect(existsSync(oldDb)).toBe(true)
    expect(existsSync(newDb)).toBe(false)
    // 原子写失败路径清理 tmp，磁盘不留残骸
    expect(readdirSync(dir).filter((f) => f.endsWith('.tmp'))).toHaveLength(0)
  })
})

describe('R41-11: 事件库迁移墓碑完整性', () => {
  it('不可解析墓碑（半截 JSON）→ 首开 fail-closed 抛错，墓碑保留且不建空库', () => {
    const ud = mkdtempTracked(join(tmpdir(), 'r41-tomb-'))
    const oldRoot = '/books/裂开的墓碑'
    const dir = join(ud, 'clwriting', 'session')
    mkdirSync(dir, { recursive: true })
    const dbPath = join(dir, bookHash(oldRoot) + '.db')
    // 半截 JSON（写中途进程死形态；写侧已原子化，此为存量/外因）
    writeFileSync(dbPath + '.migrated', '{"to": "/books/新', 'utf-8')
    try {
      // 修复前：解析失败被吞 → 墓碑被清除 → 旧路径重建空库（事件流分裂）
      expect(() => openSessionStore(ud, oldRoot)).toThrow(/墓碑不可解析/)
      // 墓碑保留（供人工核对），且未在旧路径建出空库
      expect(existsSync(dbPath + '.migrated')).toBe(true)
      expect(existsSync(dbPath)).toBe(false)
    } finally {
      rmSync(ud, { recursive: true, force: true })
    }
  })

  it('可解析墓碑的既有两态不受影响（bookRoot 在 → 过期清除放行新建）', () => {
    const ud = mkdtempTracked(join(tmpdir(), 'r41-tomb-'))
    const oldRoot = join(ud, '回来的书') // bookRoot 存在 = 同路径重新建书场景
    mkdirSync(oldRoot, { recursive: true })
    const dir = join(ud, 'clwriting', 'session')
    mkdirSync(dir, { recursive: true })
    const dbPath = join(dir, bookHash(oldRoot) + '.db')
    writeFileSync(dbPath + '.migrated', JSON.stringify({ to: '/books/别处', at: 1 }), 'utf-8')
    try {
      const store = openSessionStore(ud, oldRoot)
      expect(store).not.toBeNull()
      store!.close()
      // 过期墓碑被清除，新库在旧路径正常建立
      expect(existsSync(dbPath + '.migrated')).toBe(false)
      expect(existsSync(dbPath)).toBe(true)
    } finally {
      rmSync(ud, { recursive: true, force: true })
    }
  })
})
