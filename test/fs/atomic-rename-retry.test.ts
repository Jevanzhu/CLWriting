/**
 * R77-3（二十五轮批 D）：rename EPERM/EBUSY 退避重试单测。
 *
 * 假 rename 按脚本抛错、假 sleep 记录退避序列，断言四条契约：
 * ① 瞬时 EPERM/EBUSY（N 次后成功）→ 重试救回，退避按 base×2^n 序列；
 * ② 持续 EPERM → 1+3 次尝试后抛出（不无限等）；
 * ③ 非重试码（ENOENT）→ 立即抛，零退避（确定性错误不等）；
 * ④ 抛出的是**最后一次**错误（诊断面看到的是最终失败原因）。
 * 末尾真 fs 冒烟：默认接线（真 renameSync）与 atomicWriteFile/Stream 端到端不变。
 */
import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { atomicWriteFile, atomicWriteStream, renameWithRetry } from '../../src/fs/atomic.js'
import { mkdtempTracked } from '../helpers/temp-dir.js'

const errOf = (code: string): NodeJS.ErrnoException => Object.assign(new Error(`mock ${code}`), { code })

describe('renameWithRetry（R77-3 批 D）', () => {
  it('瞬时 EPERM（第 2 次成功）→ 重试成功，退避 50ms', () => {
    const delays: number[] = []
    let calls = 0
    renameWithRetry('a', 'b', {
      rename: () => {
        if (++calls === 1) throw errOf('EPERM')
      },
      sleep: (ms) => delays.push(ms),
    })
    expect(calls).toBe(2)
    expect(delays).toEqual([50])
  })

  it('瞬时 EBUSY（第 3 次成功）→ 退避 50/100ms 指数序列', () => {
    const delays: number[] = []
    let calls = 0
    renameWithRetry('a', 'b', {
      rename: () => {
        if (++calls <= 2) throw errOf('EBUSY')
      },
      sleep: (ms) => delays.push(ms),
    })
    expect(calls).toBe(3)
    expect(delays).toEqual([50, 100])
  })

  it('持续 EPERM → 1+3 次尝试后抛出，退避 50/100/200ms', () => {
    const delays: number[] = []
    let calls = 0
    expect(() =>
      renameWithRetry('a', 'b', {
        rename: () => {
          calls++
          throw errOf('EPERM')
        },
        sleep: (ms) => delays.push(ms),
      }),
    ).toThrow('mock EPERM')
    expect(calls).toBe(4)
    expect(delays).toEqual([50, 100, 200])
  })

  it('非重试码（ENOENT）→ 立即抛出，零退避零重试', () => {
    const delays: number[] = []
    let calls = 0
    expect(() =>
      renameWithRetry('a', 'b', {
        rename: () => {
          calls++
          throw errOf('ENOENT')
        },
        sleep: (ms) => delays.push(ms),
      }),
    ).toThrow('mock ENOENT')
    expect(calls).toBe(1)
    expect(delays).toEqual([])
  })

  it('重试耗尽 → 抛的是最后一次错误', () => {
    let calls = 0
    expect(() =>
      renameWithRetry('a', 'b', {
        rename: () => {
          calls++
          throw errOf(calls === 4 ? 'EBUSY' : 'EPERM')
        },
        sleep: () => {},
      }),
    ).toThrow('mock EBUSY')
    expect(calls).toBe(4)
  })

  it('默认接线（真 renameSync）真实重命名可用；atomicWriteFile/Stream 端到端不变', () => {
    // R26-107（二十六轮）：mkdtempTracked 接管——原 mkdtempSync 裸建零清理，
    // 真冒烟用例失败时目录在 $TMPDIR 泄漏（R72-21 助手 afterEach 兜底收走）
    const dir = mkdtempTracked('clw-rename-retry-')
    const from = join(dir, 'a.txt')
    const to = join(dir, 'b.txt')
    writeFileSync(from, 'hello')
    renameWithRetry(from, to)
    expect(existsSync(from)).toBe(false)
    expect(readFileSync(to, 'utf-8')).toBe('hello')

    atomicWriteFile(join(dir, 'w1.md'), '内容')
    expect(readFileSync(join(dir, 'w1.md'), 'utf-8')).toBe('内容')
    atomicWriteStream(join(dir, 'w2.md'), (append) => {
      append('a')
      append('b')
    })
    expect(readFileSync(join(dir, 'w2.md'), 'utf-8')).toBe('ab')
  })
})
