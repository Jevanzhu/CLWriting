/**
 * N6（五十九轮）回归：持锁方长持锁段定期 touch 锁文件续期 + 接管条件收紧为
 * 「超龄且 mtime 无续期」。
 *
 * SIGSTOP/挂起的活 pid 持锁者原先会被 MAX_HELD_MS 超龄接管 → 双持锁。现在持锁方
 * 用 renewIntervalMs 定期 utimes 刷 mtime——活着且在续期 → age 恒小于门槛不接管；
 * 只有超龄且期间无任何续期 touch 才判 stale。周期可注入保测试快。
 */
import { mkdtempSync, rmSync, writeFileSync, statSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect, afterAll } from 'vitest'
import { tryAcquireCrossProcessLock } from '../../src/fs/cross-process-lock.js'

const dir = mkdtempSync(join(tmpdir(), 'n6-lockrenew-'))
afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})
const lp = (name: string): string => join(dir, `${name}.lock`)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe('N6 锁续期', () => {
  it('renewIntervalMs 开启 → 持锁期间锁文件 mtime 被周期刷新（续期声明「还活着」）', async () => {
    const p = lp('renew')
    const release = tryAcquireCrossProcessLock(p, { renewIntervalMs: 20 })!
    expect(release).not.toBeNull()
    try {
      const m0 = Math.floor(statSync(p).mtimeMs)
      await sleep(80) // 跨 ≥3 个续期周期
      const m1 = Math.floor(statSync(p).mtimeMs)
      expect(m1).toBeGreaterThan(m0) // mtime 被 touch 抬新
    } finally {
      release()
    }
    expect(statSync(p, { throwIfNoEntry: false })).toBeUndefined() // release 停表 + 删锁文件
  })

  it('活 pid 持锁 + 超龄但 mtime 有续期 → 不被接管（收紧为「超龄且无续期」）', async () => {
    const p = lp('held-renewing')
    // R63-16：改确定性口径——原 setInterval 20ms 周期 touch 靠「检查时刻距上次
    // touch <50ms」判续期，事件循环停顿 >30ms 即 mtime 过龄假红。改为：先越过
    // maxHeldMs 窗口（无续期形态下此时必判超龄），检查前同步 touch 一次（=持锁
    // 方刚续期）——mtime 新鲜度与墙钟解耦；sleep 70 只作下界（更慢只会更「超龄」）
    writeFileSync(p, JSON.stringify({ pid: process.pid, bootTime: 0 }))
    try {
      await sleep(70) // > maxHeldMs=50 的超龄窗口，期间无续期
      utimesSync(p, new Date(), new Date()) // 持锁方续期：mtime 抬新
      // 活 pid + 超龄判定（maxHeldMs=50）→ mtime 刚被续期 → held，不接管
      const r = tryAcquireCrossProcessLock(p, { maxHeldMs: 50, staleTakeoverJitterMs: 0 })
      expect(r).toBeNull()
    } finally {
      rmSync(p, { force: true })
    }
  })

  it('活 pid 持锁 + 超龄且无续期（真死进程 pid 复用形态）→ 仍按 Z-19 超龄接管', async () => {
    const p = lp('held-stale')
    writeFileSync(p, JSON.stringify({ pid: process.pid, bootTime: 0 }))
    // 把 mtime 回拨到远超 maxHeldMs 之前（期间无任何续期 touch）
    const old = new Date(Date.now() - 120_000)
    utimesSync(p, old, old)
    const r = tryAcquireCrossProcessLock(p, { maxHeldMs: 1_000, staleTakeoverJitterMs: 0 })
    expect(r).not.toBeNull()
    r!()
  })

  it('未启用续期（缺省）→ 定时器零开销，锁语义与既有行为一致', () => {
    const p = lp('no-renew')
    const release = tryAcquireCrossProcessLock(p)!
    expect(release).not.toBeNull()
    expect(tryAcquireCrossProcessLock(p)).toBeNull() // 二次获取不接管（活 pid）
    release()
  })
})
