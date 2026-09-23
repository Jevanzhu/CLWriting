/**
 * fs/cross-process-lock.ts 单元测试（批次 J7）。
 *
 * 覆盖：tryAcquire 独占/释放幂等、活进程持锁不接管、死进程（isProcessAlive 注入
 * stub）stale 接管、锁文件损坏（空文件/非 JSON/坏 pid）视同 stale 接管、
 * acquireWithTimeout 超时返回 null、非冲突类故障（权限）原样上抛。
 * 真「双进程互斥 + 丢账」的行为级验证见 test/ai/calls-cross-process.test.ts。
 */
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chmodSync } from 'node:fs'
import { describe, it, expect, afterAll, beforeEach, vi } from 'vitest'
import {
  tryAcquireCrossProcessLock,
  acquireCrossProcessLockWithTimeout,
} from '../../src/fs/cross-process-lock.js'

// R43-25 收口回归（2026-09-04）：openSync 'wx' 的瞬态 EPERM 注入面——win delete-pending
// 窗口/杀软瞬时握锁形态。mock 工厂透传全部原实现，仅 openSync 按计数器前 N 次 'wx'
// 创建抛 EPERM（默认 0 = 全部用例原语义不受影响；用例内置数，beforeEach 归零）。
// 重评-12（全库代码重评审 2026-09-05）：同手法补删除注入面——陈锁接管的清理删除
// 已收编 rmWithRetry，用例按计数注入 EPERM 验证退避重试与耗尽上抛两面。
// RC 源码重审 A-4（Opus-5.5 轮）：接管删除改「原子改名认领」，瞬时占用面随调用面
// 迁到 rename（renameWithRetry）——注入面同步 rmSync → renameSync；另加 stealRenameAt
// 钩子，在 rename 真正落地前模拟「共享名上的锁已被他人认领走」，构造确定性交错时序。
const fsState = vi.hoisted(() => ({
  epermLeft: 0,
  renameEpermLeft: 0,
  /** A-4 交错：下一次针对该路径的 rename 之前先删掉源（= 他人已认领走）→ 真 ENOENT */
  stealRenameAt: '' as string,
  /** 上者触发后是否立刻写回一把活 pid 锁（= 那人已重建并在持锁） */
  stealRecreate: false,
}))
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    openSync: (p: string, flags: string | number, ...rest: unknown[]) => {
      if (flags === 'wx' && fsState.epermLeft > 0) {
        fsState.epermLeft--
        const err = new Error(`EPERM: operation not permitted, open '${p}'`) as NodeJS.ErrnoException
        err.code = 'EPERM'
        throw err
      }
      return (actual.openSync as (...a: unknown[]) => number)(p, flags, ...rest)
    },
    // A-4：接管面 = renameWithRetry（缺省 renameSync）——瞬态 EPERM 注入 + 交错钩子
    renameSync: (from: string, to: string) => {
      if (fsState.renameEpermLeft > 0) {
        fsState.renameEpermLeft--
        const err = new Error(`EPERM: operation not permitted, rename '${from}'`) as NodeJS.ErrnoException
        err.code = 'EPERM'
        throw err
      }
      if (fsState.stealRenameAt === from) {
        fsState.stealRenameAt = '' // 一次性钩子
        const recreate = fsState.stealRecreate
        fsState.stealRecreate = false
        // 他人已认领走共享名上的锁（其 rename 先落地）——本 contender 的 rename 随即
        // 撞真 ENOENT（源已不在）；可选：他人立即重建并在持锁（活 pid）
        ;(actual.rmSync as (p: string, o?: { force?: boolean }) => void)(from, { force: true })
        try {
          return (actual.renameSync as (a: string, b: string) => void)(from, to)
        } catch (e) {
          if (recreate) {
            ;(actual.writeFileSync as (p: string, d: string) => void)(from, JSON.stringify({ pid: process.pid, bootTime: 0 }))
          }
          throw e
        }
      }
      return (actual.renameSync as (a: string, b: string) => void)(from, to)
    },
  }
})

const dir = mkdtempSync(join(tmpdir(), 'clwriting-cplock-'))
afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})
const lp = (name: string): string => join(dir, `${name}.lock`)

beforeEach(() => {
  fsState.epermLeft = 0 // 瞬态注入计数归零（其余用例原语义零影响）
  fsState.renameEpermLeft = 0
  fsState.stealRenameAt = ''
  fsState.stealRecreate = false
})

describe('tryAcquireCrossProcessLock', () => {
  it('空闲 → 占锁成功；持有期二次获取 → null；释放后可再占', () => {
    const p = lp('basic')
    const r1 = tryAcquireCrossProcessLock(p)
    expect(r1).not.toBeNull()
    expect(tryAcquireCrossProcessLock(p)).toBeNull() // 本进程活着 → 不接管
    r1!()
    r1!() // 幂等
    const r2 = tryAcquireCrossProcessLock(p)
    expect(r2).not.toBeNull()
    r2!()
  })

  it('持锁进程已死（stub 探测）→ stale 接管清理后占锁成功', () => {
    const p = lp('stale')
    // 手工放置一个「死进程」锁：isProcessAlive stub 恒 false 模拟 ESRCH
    writeFileSync(p, JSON.stringify({ pid: 4194303, bootTime: 0 }))
    const r = tryAcquireCrossProcessLock(p, { isProcessAlive: () => false, staleTakeoverJitterMs: 0 })
    expect(r).not.toBeNull()
    r!()
  })

  it('X-4/A-4：判 stale 后锁文件已被他人换成新 pid → 二次复核拦下夺锁（不改名取走新锁）', () => {
    const p = lp('stale-recheck')
    writeFileSync(p, JSON.stringify({ pid: 4194303, bootTime: 0 }))
    let swapped = false
    const r = tryAcquireCrossProcessLock(p, {
      // 首次探测死 pid 时，模拟「另一 contender 已接管重建」——把锁文件换成活进程 pid；
      // 二次复核应读到新 pid 并按存活放行，接管改名不得执行（否则取走他人新锁 → 双持锁）
      isProcessAlive: (pid) => {
        if (pid === 4194303 && !swapped) {
          swapped = true
          writeFileSync(p, JSON.stringify({ pid: process.pid, bootTime: 0 }))
          return false
        }
        return true
      },
      staleTakeoverJitterMs: 0,
      staleGraceMs: 0,
    })
    expect(r).toBeNull() // 新持有者（本进程 pid）活着 → 不接管
    expect((JSON.parse(readFileSync(p, 'utf-8')) as { pid: number }).pid).toBe(process.pid)
  })

  it('空锁且年轻（写 pid 在途窗口）→ 视为存活不接管（staleGraceMs 宽限）', () => {
    const p = lp('young-empty')
    writeFileSync(p, '') // 模拟对手 open 'wx' 后、writeSync(pid) 前
    expect(tryAcquireCrossProcessLock(p, { isProcessAlive: () => false })).toBeNull()
    // 超龄（宽限 0）同一空锁 → 才可接管
    expect(tryAcquireCrossProcessLock(p, { isProcessAlive: () => false, staleGraceMs: 0 })).not.toBeNull()
  })

  it('锁文件损坏（空文件 / 非 JSON / 坏 pid）→ 超龄后视同 stale 接管', () => {
    for (const [name, content] of [
      ['corrupt-empty', ''],
      ['corrupt-badjson', '{oops'],
      ['corrupt-badpid', JSON.stringify({ pid: -1 })],
    ] as const) {
      const p = lp(name)
      writeFileSync(p, content)
      const r = tryAcquireCrossProcessLock(p, { isProcessAlive: () => true, staleGraceMs: 0 })
      expect(r, name).not.toBeNull()
      r!()
    }
  })

  // Windows 无 POSIX 权限位（chmod 为 no-op/仅映射只读位）；锁模块 win 失败路径已由
  // mock isProcessAlive 覆盖，该 EACCES 用例保留给 macOS/Linux CI 腿
  // R43-25 收口修订（2026-09-04）：openSync 的 EACCES/EPERM 现为瞬态重试面（win
  // delete-pending 窗口，calls-cross-process 偶挂根因）——原语在重试窗耗尽后才上抛。
  // chmod 造的是**持久**权限故障（目录只读，重试 10×5ms 不会自愈），上抛语义保持；
  // 但等待窗拉长 ~50ms，原有「toThrow 即可」断言仍成立，用例保留原样。
  it.skipIf(process.platform === 'win32')('非冲突类故障（EACCES）原样上抛——不吞权限/磁盘错误', () => {
    const sub = join(dir, 'no-perm')
    mkdirSync(sub, { recursive: true })
    chmodSync(sub, 0o500)
    try {
      expect(() => tryAcquireCrossProcessLock(join(sub, 'x.lock'))).toThrow()
    } finally {
      chmodSync(sub, 0o755)
    }
  })

  // R43-25 收口（2026-09-04）：win delete-pending/杀软瞬态——对手 rmSync 释放锁文件
  // 后的删除在途窗口内，'wx' 创建报 EPERM/EACCES（非 EEXIST）。原语短微睡重试，窗口
  // 消散后创建成功；真双进程回归（calls-cross-process）的子进程崩溃即此根因。
  it('EPERM 瞬态（win delete-pending 窗口）→ 重试后占锁成功', () => {
    const p = lp('transient-eperm')
    // 前 3 次 'wx' 创建抛 EPERM（模拟对手 rmSync 后的删除在途窗），重试窗内消散
    fsState.epermLeft = 3
    const r = tryAcquireCrossProcessLock(p)
    expect(r).not.toBeNull()
    expect(fsState.epermLeft).toBe(0) // 3 次瞬态都被重试吸收
    expect((JSON.parse(readFileSync(p, 'utf-8')) as { pid: number }).pid).toBe(process.pid)
    r!()
  })

  // 重评-12（全库代码重评审 2026-09-05）：陈锁接管的清理删除收编 fs/atomic.ts
  // rmWithRetry——win 杀软/索引器对死进程遗留锁文件瞬时锁定（EPERM/EBUSY）下裸
  // rmSync 直败会让接管无谓失败。
  // RC 源码重审 A-4（Opus-5.5 轮）：接管改「原子改名认领」（rename → 唯一隔离名 → 删），
  // 瞬时占用面随调用面由 rmWithRetry 迁到 renameWithRetry——两点用例注入面同步换装，
  // 「瞬态吸收 / 耗尽上抛」两条断言语义逐条不动。
  it('重评-12/A-4：陈锁接管改名撞瞬时 EPERM → 退避重试后接管成功', () => {
    const p = lp('stale-takeover-eperm')
    writeFileSync(p, JSON.stringify({ pid: 4194303, bootTime: 0 }))
    fsState.renameEpermLeft = 1 // 接管改名首撞瞬时锁（一次后放行——瞬时占用形态）
    const r = tryAcquireCrossProcessLock(p, { isProcessAlive: () => false, staleTakeoverJitterMs: 0 })
    expect(r).not.toBeNull()
    expect(fsState.renameEpermLeft).toBe(0) // 一次性瞬时锁被退避重试吸收（裸 rename 时代此处直败）
    expect((JSON.parse(readFileSync(p, 'utf-8')) as { pid: number }).pid).toBe(process.pid)
    r!()
  })

  it('重评-12/A-4：接管改名持续 EPERM → 重试耗尽仍上抛（不吞错，调用方超时降级面不变）', () => {
    const p = lp('stale-takeover-eperm-exhaust')
    writeFileSync(p, JSON.stringify({ pid: 4194303, bootTime: 0 }))
    fsState.renameEpermLeft = 99 // 持续占用（非瞬时形态）
    expect(() =>
      tryAcquireCrossProcessLock(p, { isProcessAlive: () => false, staleTakeoverJitterMs: 0 }),
    ).toThrowError(/EPERM/)
    fsState.renameEpermLeft = 0 // 收尾放行，手工清走残留死锁文件（认领改名从未成功）
    rmSync(p, { force: true })
  })

  // RC 源码重审 A-4（Opus-5.5 轮）：接管 = rename 到同目录唯一隔离名（`.名字.pid.uuid.tmp`）
  // 后再 best-effort 删——正常接管不得在锁目录留隔离残迹（否则每次接管漏一个文件，
  // 只能等 sweepAbandonedTmpFiles 的 5min 年龄门清）。
  it('A-4：接管成功后锁目录无 .tmp 隔离残迹（死锁原件已随隔离名删除）', () => {
    const sub = join(dir, 'quarantine-clean')
    mkdirSync(sub, { recursive: true })
    const p = join(sub, 'stale.lock')
    writeFileSync(p, JSON.stringify({ pid: 4194303, bootTime: 0 }))
    const r = tryAcquireCrossProcessLock(p, { isProcessAlive: () => false, staleTakeoverJitterMs: 0 })
    expect(r).not.toBeNull()
    expect(readdirSync(sub)).toEqual(['stale.lock']) // 只剩本进程新建的锁，无隔离件残留
    r!()
  })

  // RC 源码重审 A-4（Opus-5.5 轮）交错时序之一：A 已把共享名上的死锁改名认领走（旧实现
  // 此处是「删共享名 → 自建」两步），B 的 rename 因此得 ENOENT（源已不在）——B 不得把
  // 它当故障上抛、不得触碰任何文件，而应落回 create 路径建成自己的锁（结束时恰好一把锁）。
  it('A-4 交错：A 已认领走 → B 的 rename 撞 ENOENT → 不误删不误判，正常重建（互斥成立）', () => {
    const p = lp('a4-lost-race')
    writeFileSync(p, JSON.stringify({ pid: 4194303, bootTime: 0 }))
    fsState.stealRenameAt = p // 本 contender 的 rename 落地前，源被「他人」取走
    const r = tryAcquireCrossProcessLock(p, { isProcessAlive: () => false, staleTakeoverJitterMs: 0 })
    expect(r).not.toBeNull() // ENOENT 未被当成故障上抛（旧 rm 面此处不可观测，故无从区分）
    expect((JSON.parse(readFileSync(p, 'utf-8')) as { pid: number }).pid).toBe(process.pid)
    expect(readdirSync(dir).filter((n) => n.endsWith('.tmp'))).toEqual([]) // 败者零隔离残迹
    r!()
  })

  // RC 源码重审 A-4（Opus-5.5 轮）交错时序之二：A 认领走死锁后立刻重建并在持锁（活 pid），
  // B 的 rename 才落地——B 仍只可能得 ENOENT（源已被 A 取走），随后落回 create 路径撞
  // EEXIST，按 A 的活 pid 判定为「在持」→ 不接管、不删、不双持。旧实现此处 B 的 rm
  // 落在共享名上会直接删掉 A 的新锁再自建（双持锁）——本用例即该路径的回归。
  it('A-4 交错：rename 落败者不得删掉 A 刚重建的活锁（不误删、不误判为可接管）', () => {
    const p = lp('a4-lost-race-live')
    writeFileSync(p, JSON.stringify({ pid: 4194303, bootTime: 0 }))
    fsState.stealRenameAt = p
    fsState.stealRecreate = true // A 已在位并在持锁
    const r = tryAcquireCrossProcessLock(p, {
      isProcessAlive: (pid) => pid !== 4194303, // 死锁 pid 已死；A（本进程）活着
      staleTakeoverJitterMs: 0,
    })
    expect(r).toBeNull() // A 在持锁 → 不接管
    expect((JSON.parse(readFileSync(p, 'utf-8')) as { pid: number }).pid).toBe(process.pid) // A 的锁原样在位
    // 收尾：A 释放后本进程可正常重建（互斥链未被败者的失败打断）
    rmSync(p, { force: true })
    const r2 = tryAcquireCrossProcessLock(p)
    expect(r2).not.toBeNull()
    r2!()
  })
})

describe('acquireCrossProcessLockWithTimeout', () => {
  it('空闲 → 立即成功（不等满超时）', () => {
    // R63-16：超时 200→2000、上界 150→1000——空闲路径首次尝试即成功（零睡眠），
    // 界值只需低于超时即保判别力「没等满超时」；150ms 墙钟上界在 fork 级停顿下假红
    const t0 = Date.now()
    const r = acquireCrossProcessLockWithTimeout(lp('free'), 2000)
    expect(r).not.toBeNull()
    expect(Date.now() - t0).toBeLessThan(1000)
    r!()
  })

  it('被本进程持有（事件循环阻塞无法自释）→ 超时返回 null', () => {
    const p = lp('held')
    const hold = tryAcquireCrossProcessLock(p)
    expect(hold).not.toBeNull()
    const r = acquireCrossProcessLockWithTimeout(p, 30)
    expect(r).toBeNull()
    hold!()
  })
})

// ── R65-35（第六十五轮）：writeSync 循环写满 + 释放前校验锁归属 ────────────────

describe('R65-35: 释放校验（不删他人锁）', () => {
  it('锁内容非自身（被他人换掉）→ release 不删他人锁（X-4 双持锁残余窗口消解）', () => {
    const p = lp('r65-35-foreign')
    const acquire = tryAcquireCrossProcessLock(p)
    expect(acquire).not.toBeNull()
    // 模拟 X-4 残余窗口：持锁期间锁文件被 stale 接管者删掉并重建为他人（他 pid）的锁
    const foreign = JSON.stringify({ pid: process.pid + 1, bootTime: 12345 })
    writeFileSync(p, foreign)
    acquire!() // 释放：内容与自身写入串不一致 → 不删
    // 他人锁原样在位（无条件 rmSync 会把它删掉 → 双持锁互斥失效）
    expect(readFileSync(p, 'utf-8')).toBe(foreign)
    // 清理（本测试自持的外来锁文件）
    rmSync(p, { force: true })
  })

  it('锁内容仍为自身 → release 正常删（回归）', () => {
    const p = lp('r65-35-own')
    const acquire = tryAcquireCrossProcessLock(p)
    expect(acquire).not.toBeNull()
    acquire!()
    expect(() => readFileSync(p, 'utf-8')).toThrow() // 已删
  })

  it('锁文件写入串是完整 JSON（pid+bootTime 可解析）——循环写满不留半写', () => {
    const p = lp('r65-35-payload')
    const acquire = tryAcquireCrossProcessLock(p)
    expect(acquire).not.toBeNull()
    try {
      const parsed = JSON.parse(readFileSync(p, 'utf-8')) as { pid: number; bootTime: number }
      expect(parsed.pid).toBe(process.pid)
      expect(Number.isFinite(parsed.bootTime)).toBe(true)
    } finally {
      acquire!()
    }
  })
})
