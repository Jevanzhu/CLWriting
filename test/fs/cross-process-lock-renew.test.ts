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
import { describe, it, expect, afterAll, vi } from 'vitest'
import { tryAcquireCrossProcessLock } from '../../src/fs/cross-process-lock.js'

const dir = mkdtempSync(join(tmpdir(), 'n6-lockrenew-'))
afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})
const lp = (name: string): string => join(dir, `${name}.lock`)

describe('N6 锁续期', () => {
  it('renewIntervalMs 开启 → 持锁期间锁文件 mtime 被周期刷新（续期声明「还活着」）', async () => {
    const p = lp('renew')
    const release = tryAcquireCrossProcessLock(p, { renewIntervalMs: 20 })!
    expect(release).not.toBeNull()
    try {
      const m0 = Math.floor(statSync(p).mtimeMs)
      // R0915-4d（台账行 259 择收）：续期周期性抬新是必然终态——固定 80ms 窗改轮询至
      // mtime 抬新（慢机不假红；mtime 被 touch 抬新）
      // 帽 2_000 → 10_000（win 腿间歇红台账在册观察）：等待目标是「20ms 续期定时器至少
      // 跑一拍」，CI 慢机（2 fork 并发 + GB 级邻档 CPU 争用/suite 收尾）可把定时器饿死过
      // 2s 而假红；10_000 = 500× 续期周期，仍在 30s 全局用例帽之内——真回归（定时器没起/
      // 不 touch）照样必红，判据仍是「mtime 被抬新」逐字未动。
      await vi.waitFor(() => expect(statSync(p).mtimeMs).toBeGreaterThan(m0), { timeout: 10_000 })
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
    // 方刚续期）——mtime 新鲜度与墙钟解耦。
    // 加固（win 腿间歇红台账在册观察）：①原固定 sleep(70) 改「轮询到真实年龄越窗」——
    // 条件成立即续，「已超龄且无续期」的前置形态从「假定成立」变为「断言成立」（比固定
    // 毫秒更硬，非弱化），且 mtime 可超前墙钟的 win 粒度形态被轮询自然吸收；
    // ②touch 与判龄（acquire 内 statSync）之间若被调度停顿越窗（慢机 GC/杀软/IO 停顿
    // > maxHeldMs=50），会现「续期被忽略」的假接管——整段在预算内重放隔离该调度伪影。
    // 真回归无随机源（jitter 注入 0，判定逐位确定），每次尝试同判必红，故重放不减弱判别力。
    const maxHeldMs = 50
    const replayEnd = Date.now() + 3_000 // 重放预算：够吸收调度尖峰，远小于 30s 全局用例帽
    let takeover = false
    do {
      // 夹具：活 pid（本进程）持锁。年龄窗必须由真实流逝时间建立——回拨 mtime 不行：
      // 那会让「按创建时刻/ctime 计龄」的回归形态躲过本用例（回拨后创建龄仍是 0）。
      rmSync(p, { force: true })
      writeFileSync(p, JSON.stringify({ pid: process.pid, bootTime: 0 }))
      try {
        await vi.waitFor(() => expect(Date.now() - Math.floor(statSync(p).mtimeMs)).toBeGreaterThan(maxHeldMs), {
          timeout: 10_000,
          interval: 5,
        })
        utimesSync(p, new Date(), new Date()) // 持锁方续期：mtime 抬新
        // 活 pid + 超龄判定（maxHeldMs=50）→ mtime 刚被续期 → held，不接管
        const r = tryAcquireCrossProcessLock(p, { maxHeldMs, staleTakeoverJitterMs: 0 })
        takeover = r !== null
        r?.() // 假接管形态（touch→判龄间被暂停越窗）：释放本进程刚建的锁，下轮重建夹具重放
      } finally {
        rmSync(p, { force: true })
      }
    } while (takeover && Date.now() < replayEnd)
    // 首次尝试即 null 时本断言与原 `expect(r).toBeNull()` 逐字同义；只有调度伪影形态才靠
    // 重放洗掉（真回归每次尝试同判 → 全红，不因重放变绿）
    expect(takeover).toBe(false)
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
