/**
 * fs/cross-process-lock.ts 异步占锁原语（R30-6，三十轮）。
 *
 * 覆盖：acquireCrossProcessLockAsync 空闲即得、持有期超时 null、等待期间事件循环
 * 不被阻塞（setTimeout 照常触发）、持锁方中途释放 → 等待者拿到锁、timeoutMs=0
 * 退化 try-acquire（不等待）。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect, afterAll } from 'vitest'
import {
  tryAcquireCrossProcessLock,
  acquireCrossProcessLockAsync,
} from '../../src/fs/cross-process-lock.js'

const dir = mkdtempSync(join(tmpdir(), 'clwriting-cplock-async-'))
afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})
const lp = (name: string): string => join(dir, `${name}.lock`)

describe('acquireCrossProcessLockAsync', () => {
  it('空闲 → 立即占锁；释放后可再占', async () => {
    const p = lp('free')
    const r1 = await acquireCrossProcessLockAsync(p, 5_000)
    expect(r1).not.toBeNull()
    r1!()
    const r2 = await acquireCrossProcessLockAsync(p, 5_000)
    expect(r2).not.toBeNull()
    r2!()
  })

  it('被活进程持锁 → 轮询至超时返回 null', async () => {
    const p = lp('timeout')
    const holder = tryAcquireCrossProcessLock(p)
    expect(holder).not.toBeNull()
    const t0 = Date.now()
    const r = await acquireCrossProcessLockAsync(p, 80, { pollIntervalMs: 10 })
    expect(r).toBeNull()
    expect(Date.now() - t0).toBeGreaterThanOrEqual(60)
    holder!()
  })

  it('等待期间事件循环不被阻塞——外部定时器先于等待结束触发', async () => {
    const p = lp('nonblocking')
    const holder = tryAcquireCrossProcessLock(p)
    expect(holder).not.toBeNull()
    let timerFired = false
    const timer = setTimeout(() => {
      timerFired = true
    }, 20)
    const r = await acquireCrossProcessLockAsync(p, 200, { pollIntervalMs: 10 })
    expect(r).toBeNull()
    expect(timerFired).toBe(true) // 同步 Atomics.wait 版本会让本断言超时饿死
    clearTimeout(timer)
    holder!()
  })

  it('持锁方中途释放 → 等待者拿到锁', async () => {
    const p = lp('handoff')
    const holder = tryAcquireCrossProcessLock(p)
    expect(holder).not.toBeNull()
    setTimeout(() => holder!(), 50)
    const r = await acquireCrossProcessLockAsync(p, 5_000, { pollIntervalMs: 10 })
    expect(r).not.toBeNull()
    r!() // 幂等语义与同步版一致
  })

  it('timeoutMs=0 退化 try-acquire：被持锁时立即 null 不等待', async () => {
    const p = lp('zero')
    const holder = tryAcquireCrossProcessLock(p)
    expect(holder).not.toBeNull()
    const t0 = Date.now()
    const r = await acquireCrossProcessLockAsync(p, 0)
    expect(r).toBeNull()
    expect(Date.now() - t0).toBeLessThan(50)
    holder!()
  })
})
