/**
 * R38-1（三十八轮修复批）回归：事件库迁移搬移/回滚收编 renameWithRetry + 回滚失败
 * 保留墓碑。
 *
 * 原缺陷形态（win 杀软/索引器瞬时锁）：搬移 renameSync 裸调失败 → 回滚 renameSync
 * 同样裸调、失败仅记日志 → **无条件** rmSync 撤墓碑——旧位 .db 与 .migrated 双缺，
 * 迟来首开按「正常缺库」重建空库（R71-25 防线被自家回滚链拆掉，事件流分裂）。
 *
 * 本文件以 mp2-3 同款 node:fs 注入（条件性 EPERM，可配「永久失败」形态）逐臂断言：
 * ① 瞬时 EPERM 一次 → renameWithRetry 退避后迁移完成；
 * ② 侧车永久失败 + 回滚成功 → 墓碑撤除（旧位主库完整回位）；
 * ③ 回滚也不可成 → **墓碑保留**（fail-closed：迟来首开走墓碑分支拒建空库）。
 *
 * 夹具注记：侧车文件在首个 rename 调用时懒创建——迁移前置的 checkpoint(TRUNCATE)
 * 会把垃圾字节 -wal 清掉/置零，真实 WAL 在 close 时即被折叠删除，无法预先占位。
 */
import { describe, expect, it, afterEach, vi } from 'vitest'
import { rmSync, existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const failState = vi.hoisted(() => ({
  /** 命中即抛 EPERM；`permanent` = 不自动放行（重试耗尽形态），否则一次性瞬时锁形态。 */
  failWhen: null as ((from: string, to: string) => boolean) | null,
  permanent: false,
  /** 首个 rename（主库搬移）时懒创建的侧车占位路径（null = 不造侧车）。 */
  lazySidecarFor: null as string | null,
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
      if (failState.failWhen?.(from, to)) {
        if (!failState.permanent) failState.failWhen = null // 瞬时锁形态：一次后放行
        throw Object.assign(new Error(`EPERM: operation not permitted, rename '${from}' -> '${to}'`), { code: 'EPERM' })
      }
      return actual.renameSync(from, to)
    },
  }
})

import { migrateBookSession, openSessionStore, bookHash } from '../../src/events/store.js'
import { mkdtempTracked } from '../helpers/temp-dir.js'

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
  return { oldDb, newDb: join(dir, bookHash(oldRoot + '-new') + '.db') }
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
})
