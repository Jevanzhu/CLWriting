/**
 * fs/cross-process-lock.ts 单元测试（批次 J7）。
 *
 * 覆盖：tryAcquire 独占/释放幂等、活进程持锁不接管、死进程（isProcessAlive 注入
 * stub）stale 接管、锁文件损坏（空文件/非 JSON/坏 pid）视同 stale 接管、
 * acquireWithTimeout 超时返回 null、非冲突类故障（权限）原样上抛。
 * 真「双进程互斥 + 丢账」的行为级验证见 test/ai/calls-cross-process.test.ts。
 */
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chmodSync } from 'node:fs'
import { describe, it, expect, afterAll } from 'vitest'
import {
  tryAcquireCrossProcessLock,
  acquireCrossProcessLockWithTimeout,
} from '../../src/fs/cross-process-lock.js'

const dir = mkdtempSync(join(tmpdir(), 'clwriting-cplock-'))
afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})
const lp = (name: string): string => join(dir, `${name}.lock`)

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

  it('X-4：判 stale 后锁文件已被他人换成新 pid → 二次复核拦下 rmSync（不删新锁）', () => {
    const p = lp('stale-recheck')
    writeFileSync(p, JSON.stringify({ pid: 4194303, bootTime: 0 }))
    let swapped = false
    const r = tryAcquireCrossProcessLock(p, {
      // 首次探测死 pid 时，模拟「另一 contender 已接管重建」——把锁文件换成活进程 pid；
      // 二次复核应读到新 pid 并按存活放行，rmSync 不得执行（否则删掉他人新锁 → 双持锁）
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

  it('非冲突类故障（EACCES）原样上抛——不吞权限/磁盘错误', () => {
    const sub = join(dir, 'no-perm')
    mkdirSync(sub, { recursive: true })
    chmodSync(sub, 0o500)
    try {
      expect(() => tryAcquireCrossProcessLock(join(sub, 'x.lock'))).toThrow()
    } finally {
      chmodSync(sub, 0o755)
    }
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
