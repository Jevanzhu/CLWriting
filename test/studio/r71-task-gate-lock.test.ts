/**
 * R71-3（十九轮）回归：任务闸跨进程锁的续期与归属释放。
 *
 * - 续期：闸在途时锁文件 mtime 被定时刷新——超龄（>10min）不再被第二竞争者按
 *   「活 pid 超龄」接管（Z-19 语义只打击真死进程的 pid 复用残留）。
 * - 归属释放：release 走锁原语的 payload 校验版（R65-35②）——锁文件内容已非本进程
 *   写入串（被接管/被重建）时不删，他人在位的新锁得以幸存。
 */
import { afterAll, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, existsSync, writeFileSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { acquireTaskGate, isTaskGateHeld } from '../../src/studio/server/api/task-gate.js'
import { tryAcquireCrossProcessLock } from '../../src/fs/cross-process-lock.js'

const roots: string[] = []
function freshDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'r71-task-gate-'))
  roots.push(d)
  return d
}
afterAll(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true })
})

function lockPathOf(dir: string, book: string, action: string): string {
  const key = `${action}\u0000${book}`
  const name = createHash('sha256').update(key).digest('hex').slice(0, 16) + '.lock'
  return join(dir, name)
}

describe('R71-3 任务闸锁续期', () => {
  it('在途闸超龄不接管：mtime 被续期刷新后，第二竞争者 tryAcquire 拿不到锁', async () => {
    const dir = freshDir()
    const book = '续期书'
    const release = acquireTaskGate(book, 'analyze', { lockDir: dir, renewIntervalMs: 20 })
    expect(release).not.toBeNull()
    const lockPath = lockPathOf(dir, book, 'analyze')

    // 把锁龄拨回 11 分钟（模拟长任务持闸超 Z-19 的 10min 线）
    const past = new Date(Date.now() - 11 * 60_000)
    utimesSync(lockPath, past, past)
    // 等续期 tick 刷新 mtime（20ms 周期，等 80ms 足够）
    await new Promise((r) => setTimeout(r, 80))
    // 第二竞争者（等价他进程视角）对同一路径 tryAcquire：活 pid + mtime 新鲜 → held
    const rival = tryAcquireCrossProcessLock(lockPath)
    expect(rival).toBeNull()

    release!()
    expect(existsSync(lockPath)).toBe(false)
  })

  it('归属释放：锁内容被换成他人写入串后 release 不删他人在位新锁，进程内闸照常清', () => {
    const dir = freshDir()
    const book = '归属书'
    const release = acquireTaskGate(book, 'review', { lockDir: dir })
    expect(release).not.toBeNull()
    expect(isTaskGateHeld(book, 'review')).toBe(true)
    const lockPath = lockPathOf(dir, book, 'review')

    // 模拟「本闸锁已被接管/重建」：锁文件内容换成他人 payload——pid 取「必活他进程」
    // （POSIX 1=init 恒活；win 4=System 恒在，pid 1 在 win 多半不存在会被误判死锁 →
    // stale 接管 → 假红。J0（win 适配）实测修正）
    const liveForeignPid = process.platform === 'win32' ? 4 : 1
    writeFileSync(lockPath, JSON.stringify({ pid: liveForeignPid, bootTime: 0 }), 'utf-8')

    release!()
    // 他人在位的新锁幸存（校验版释放读到不一致即不删）
    expect(existsSync(lockPath)).toBe(true)
    // 进程内闸照常释放——同 key 可再次占闸（文件锁侧因他人活锁返回 null，语义正确）
    expect(isTaskGateHeld(book, 'review')).toBe(false)
    const again = acquireTaskGate(book, 'review', { lockDir: dir })
    expect(again).toBeNull()
    // 清理：交给调用方视角外的锁文件，直接删掉防影响后续用例目录（各自独立 tmpdir，双保险）
    rmSync(lockPath, { force: true })
  })
})
