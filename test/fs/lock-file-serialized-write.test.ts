/**
 * R0916-7-P3-3（2026-09-16 评审修复批）：serializedLockedWrite 新家导出面直测。
 *
 * 被测行为：写链队列 + 跨进程锁的写段原语自 ai/calls.ts 下沉 fs/lock-file.ts 后语义
 * 逐位不变——① 空闲快路同步直行且跨进程锁已释放（不留残锁）；② 在途段让后续写排队，
 * 调用序 = 落盘序；③ returnInflight 两档返回口径（providers 侧随 promise 上抛 /
 * calls 侧恒 undefined 由旁挂 warn 承担）；④ 锁被占超时按 lockTimeoutMsg 表达失败，
 * 且旁挂分支不产生 unhandled rejection。链条由调用方持有（本测试自建 Map）。
 */
import { describe, expect, it, vi } from 'vitest'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { serializedLockedWrite, type SerializedLockedWriteOpts } from '../../src/fs/lock-file.js'
import { tryAcquireCrossProcessLock } from '../../src/fs/cross-process-lock.js'
import { mkdtempTracked } from '../helpers/temp-dir.js'

function optsOf(over: Partial<SerializedLockedWriteOpts> = {}): SerializedLockedWriteOpts {
  return {
    warnTag: 'p33-lock',
    fastWarn: (m) => `快路失败：${m}`,
    queuedWarn: (m) => `排队失败：${m}`,
    lockTimeoutMs: () => 5_000,
    lockTimeoutMsg: '锁获取超时（p33 测试）',
    returnInflight: true,
    ...over,
  }
}

const lockPathIn = (dir: string): string => join(dir, 'write.lock')

describe('fs/lock-file：serializedLockedWrite 导出面（R0916-7-P3-3）', () => {
  it('空闲快路：写段同步执行、返回 undefined、跨进程锁已释放（无残锁）', () => {
    const dir = mkdtempTracked(join(tmpdir(), 'p33-lock-fast-'))
    const lockPath = lockPathIn(dir)
    const seen: string[] = []
    const r = serializedLockedWrite(new Map(), 'k', lockPath, () => seen.push('write'), optsOf())
    expect(r).toBeUndefined()
    expect(seen).toEqual(['write'])
    expect(existsSync(lockPath)).toBe(false)
  })

  it('在途段让后续写排队：调用序 = 落盘序，两段都执行且锁无残留', async () => {
    const dir = mkdtempTracked(join(tmpdir(), 'p33-lock-queue-'))
    const lockPath = lockPathIn(dir)
    const order: string[] = []
    let releaseInflight: () => void = () => {}
    const inflight = new Promise<void>((res) => (releaseInflight = res))
    const chains = new Map<string, Promise<unknown>>([['k', inflight]])

    const p = serializedLockedWrite(chains, 'k', lockPath, () => order.push('second'), optsOf())
    expect(order).toEqual([]) // 首段在途 → 本段排队未执行
    order.push('first')
    releaseInflight()
    await p
    expect(order).toEqual(['first', 'second'])
    expect(existsSync(lockPath)).toBe(false)
  })

  it('returnInflight=false（calls 记账侧口径）：排队段返回 undefined，写仍照常发生', async () => {
    const dir = mkdtempTracked(join(tmpdir(), 'p33-lock-noinflight-'))
    const lockPath = lockPathIn(dir)
    const order: string[] = []
    let releaseInflight: () => void = () => {}
    const inflight = new Promise<void>((res) => (releaseInflight = res))
    const chains = new Map<string, Promise<unknown>>([['k', inflight]])

    const p = serializedLockedWrite(chains, 'k', lockPath, () => order.push('queued'), optsOf({ returnInflight: false }))
    expect(p).toBeUndefined()
    releaseInflight()
    // 排队段为微任务链执行（await 让出后可见）
    await vi.waitFor(() => expect(order).toEqual(['queued']))
    expect(existsSync(lockPath)).toBe(false)
  })

  it('锁被他人持有：超时按 lockTimeoutMsg 拒绝（returnInflight=true 随 promise 上抛）', async () => {
    const dir = mkdtempTracked(join(tmpdir(), 'p33-lock-timeout-'))
    const lockPath = lockPathIn(dir)
    // 同进程持锁（锁文件 pid = 本进程且存活）→ 异步获取必超时（同进程嵌套自锁口径）
    const held = tryAcquireCrossProcessLock(lockPath)
    expect(held).not.toBeNull()
    try {
      const warn = vi.spyOn(console, 'error').mockImplementation(() => {})
      try {
        const p = serializedLockedWrite(new Map(), 'k', lockPath, () => {}, optsOf({ lockTimeoutMs: () => 1 }))
        await expect(p).rejects.toThrow('锁获取超时（p33 测试）')
      } finally {
        warn.mockRestore()
      }
    } finally {
      held!()
    }
    expect(existsSync(lockPath)).toBe(false)
  })

  it('超时在 returnInflight=false 档：失败由旁挂 warn 承担（不抛、不产生 unhandled rejection）', async () => {
    const dir = mkdtempTracked(join(tmpdir(), 'p33-lock-quiet-timeout-'))
    const lockPath = lockPathIn(dir)
    const held = tryAcquireCrossProcessLock(lockPath)
    expect(held).not.toBeNull()
    const unhandled: unknown[] = []
    const onUnhandled = (e: unknown): void => void unhandled.push(e)
    process.on('unhandledRejection', onUnhandled)
    try {
      const r = serializedLockedWrite(new Map(), 'k', lockPath, () => {}, optsOf({ lockTimeoutMs: () => 1, returnInflight: false }))
      expect(r).toBeUndefined()
      // 让排队/在途微任务链跑完（在途段失败走旁挂 warn，不逃逸为 unhandled）
      await new Promise((res) => setTimeout(res, 50))
      expect(unhandled).toEqual([])
    } finally {
      process.off('unhandledRejection', onUnhandled)
      held!()
    }
  })
})
