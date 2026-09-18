/**
 * 0918二轮修复批（D102）：safeTokenCompare 摘要化常量时间比较回归——原实现长度
 * 不等提前 return false（比较耗时与期望值长度相关，泄露 secret 长度时序信号）。
 * 修复：两侧各先 SHA-256 摘要成 32 字节定长再 timingSafeEqual。
 *
 * 手法：vi.mock node:crypto 的 timingSafeEqual 为透传 spy（等值语义与真实实现一致
 * 的 XOR 累计替身；长度不等同抛 RangeError——真实实现同款，恰好锁死「进入比较的
 * 缓冲区必须等长」），断言不等长输入也进入比较且两侧恒 32 字节（SHA-256 摘要定长，
 * 长度信道消除），非字符串保持 false 快路径不进比较。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { timingSafeEqualSpy } = vi.hoisted(() => ({
  timingSafeEqualSpy: vi.fn((a: Uint8Array, b: Uint8Array): boolean => {
    if (a.length !== b.length) {
      // 真实 timingSafeEqual 长度不等即抛——若被测实现漏摘要有长度差，这里直接炸测试
      throw new RangeError(`timingSafeEqual 长度不等（${a.length} vs ${b.length}）`)
    }
    let diff = 0
    for (let i = 0; i < a.length; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0)
    return diff === 0
  }),
}))

vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>()
  return { ...actual, timingSafeEqual: timingSafeEqualSpy }
})

import { safeTokenCompare } from '../../src/studio/server/http.js'

/** 断言最近一次比较的两侧缓冲区形状：SHA-256 摘要恒 32 字节 */
function lastCompareArgs(): [Uint8Array, Uint8Array] {
  const call = timingSafeEqualSpy.mock.calls.at(-1)
  if (!call) throw new Error('timingSafeEqual 未被调用')
  return call
}

beforeEach(() => {
  timingSafeEqualSpy.mockClear()
})

describe('D102：safeTokenCompare 摘要化（长度信道消除）', () => {
  it('相等 token → true，进入比较的两侧恒 SHA-256 32 字节', () => {
    expect(safeTokenCompare('6f1c2e8a-9b7d-4c3a', '6f1c2e8a-9b7d-4c3a')).toBe(true)
    const [a, b] = lastCompareArgs()
    expect(a.length).toBe(32)
    expect(b.length).toBe(32)
  })

  it('等长不等值 → false（既有语义面）', () => {
    expect(safeTokenCompare('aaaaaaaaaaaaaaaa', 'bbbbbbbbbbbbbbbb')).toBe(false)
    expect(timingSafeEqualSpy).toHaveBeenCalledTimes(1) // 未提前 return，进了常量时间比较
  })

  it('不等长输入不再提前 return：仍进入定长比较且返回 false（长度信道消除的核心断言）', () => {
    expect(safeTokenCompare('short', 'a-much-longer-expected-studio-token')).toBe(false)
    expect(timingSafeEqualSpy).toHaveBeenCalledTimes(1) // 原实现此处 0 次（提前 return）
    const [a, b] = lastCompareArgs()
    expect(a.length).toBe(32) // 摘要化：输入再长再短，比较面恒定长
    expect(b.length).toBe(32)
  })

  it('超长输入同样归一到 32 字节比较（摘要化，非逐字节直比）', () => {
    expect(safeTokenCompare('x'.repeat(10_000), 'y'.repeat(10_000))).toBe(false)
    const [a, b] = lastCompareArgs()
    expect(a.length).toBe(32)
    expect(b.length).toBe(32)
  })

  it('非字符串（undefined / 数组 / 数字头形态）→ false 且不进入比较（快路径保持）', () => {
    expect(safeTokenCompare(undefined, 'token')).toBe(false)
    expect(safeTokenCompare(['token'], 'token')).toBe(false)
    expect(safeTokenCompare(undefined as unknown as string, 'token')).toBe(false)
    expect(timingSafeEqualSpy).not.toHaveBeenCalled()
  })
})
