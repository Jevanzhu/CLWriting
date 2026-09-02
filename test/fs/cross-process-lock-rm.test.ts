/**
 * R1W-2（win 平台专项复审 R1）：锁文件释放删除防护 rmWithRetryQuiet 单测 + release 反噬回归。
 *
 * 契约：① EPERM/EBUSY 瞬时占用按 3×50ms 指数退避重试救回；
 * ② 持续占用/确定性错误 → 重试耗尽后静默放弃 + 不反抛（release 在调用方 finally 中，
 *    抛错会顶替已成功的受锁操作结果）；残留交陈锁接管/清扫自愈。
 * 真 fs 回归：占住锁文件句柄后 release 不抛（win 上句柄未关删不掉 → 残留；posix 照删）。
 */
import { describe, expect, it } from 'vitest'
import { closeSync, existsSync, openSync } from 'node:fs'
import { join } from 'node:path'
import { acquireCrossProcessLockWithTimeout, rmWithRetryQuiet } from '../../src/fs/cross-process-lock.js'
import { mkdtempTracked } from '../helpers/temp-dir.js'

const errOf = (code: string): NodeJS.ErrnoException => Object.assign(new Error(`mock ${code}`), { code })

describe('rmWithRetryQuiet（R1W-2）', () => {
  it('瞬时 EBUSY（第 3 次成功）→ 重试救回，退避 50/100ms 指数序列', () => {
    const delays: number[] = []
    let calls = 0
    rmWithRetryQuiet('a.lock', {
      rm: () => {
        if (++calls <= 2) throw errOf('EBUSY')
      },
      sleep: (ms) => delays.push(ms),
    })
    expect(calls).toBe(3)
    expect(delays).toEqual([50, 100])
  })

  it('瞬时 EPERM（第 2 次成功）→ 重试救回', () => {
    const delays: number[] = []
    let calls = 0
    rmWithRetryQuiet('a.lock', {
      rm: () => {
        if (++calls === 1) throw errOf('EPERM')
      },
      sleep: (ms) => delays.push(ms),
    })
    expect(calls).toBe(2)
    expect(delays).toEqual([50])
  })

  it('持续 EBUSY → 重试耗尽（1+3 次）后静默放弃，不反抛', () => {
    let calls = 0
    expect(() =>
      rmWithRetryQuiet('a.lock', {
        rm: () => {
          calls++
          throw errOf('EBUSY')
        },
        sleep: () => {},
      }),
    ).not.toThrow()
    expect(calls).toBe(4)
  })

  it('确定性错误（EACCES）→ 立即放弃零退避，不反抛', () => {
    let calls = 0
    const delays: number[] = []
    expect(() =>
      rmWithRetryQuiet('a.lock', {
        rm: () => {
          calls++
          throw errOf('EACCES')
        },
        sleep: (ms) => delays.push(ms),
      }),
    ).not.toThrow()
    expect(calls).toBe(1)
    expect(delays).toEqual([])
  })
})

describe('release 删除失败不反噬调用方（R1W-2 真 fs 回归）', () => {
  // 真 fs 冒烟：锁文件句柄未关时（并发读形态）release 照常收口不抛——正常路径删除成功；
  // 「删除被拒」分支 Node 侧无法便携构造（自身句柄带 share-delete，编辑器/杀软形态），
  // 该契约由上方注入式用例覆盖。
  it('锁文件被并发句柄打开时 release 不抛且锁已释放', () => {
    const dir = mkdtempTracked('r1w2-lock-rm-')
    const lockPath = join(dir, 'op.lock')
    const release = acquireCrossProcessLockWithTimeout(lockPath, 1000, { staleGraceMs: 0 })
    expect(release).not.toBeNull()
    const fd = openSync(lockPath, 'r+') // 并发持有读句柄（最接近真实的占用形态）
    try {
      expect(() => release!()).not.toThrow()
    } finally {
      closeSync(fd)
    }
    expect(existsSync(lockPath)).toBe(false)
  })
})
