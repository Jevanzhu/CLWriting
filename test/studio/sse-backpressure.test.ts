/**
 * P-8（第十四轮）：SSE 写背压判死单测（createSseWriter 纯逻辑，注入假 res）。
 *
 * 覆盖：正常写透传 / false 累计不过阈不断连 / 超阈 destroy / drain 复位 /
 * 已断开（writableEnded / destroyed）静默丢弃。
 */
import { describe, it, expect } from 'vitest'
import { createSseWriter } from '../../src/studio/server/api/stream.js'

interface FakeRes {
  writableEnded: boolean
  destroyed: boolean
  writeReturns: boolean
  writes: string[]
  destroyCount: number
  listeners: Map<string, () => void>
  write(chunk: string): boolean
  on(ev: string, fn: () => void): void
  destroy(): void
}

function fakeRes(writeReturns: boolean): FakeRes {
  const r = {
    writableEnded: false,
    destroyed: false,
    writeReturns,
    writes: [] as string[],
    destroyCount: 0,
    listeners: new Map<string, () => void>(),
    write(chunk: string) {
      r.writes.push(chunk)
      return r.writeReturns
    },
    on(ev: string, fn: () => void) {
      r.listeners.set(ev, fn)
    },
    destroy() {
      r.destroyCount++
      r.destroyed = true
    },
  }
  return r
}

describe('createSseWriter / P-8 写背压判死', () => {
  it('write 返回 true：透传并复位累计（无背压）', () => {
    const res = fakeRes(true)
    const w = createSseWriter(res, 10)
    w('a'.repeat(50))
    w('b'.repeat(50))
    expect(res.writes).toEqual(['a'.repeat(50), 'b'.repeat(50)])
    expect(res.destroyCount).toBe(0)
  })

  it('write 返回 false：累计不过阈不断连，跨调用累加', () => {
    const res = fakeRes(false)
    const w = createSseWriter(res, 100)
    w('a'.repeat(40))
    w('b'.repeat(40)) // 累计 80 ≤ 100
    expect(res.destroyCount).toBe(0)
    expect(res.writes).toHaveLength(2)
  })

  it('累计超阈 → destroy 判死（且只判一次）', () => {
    const res = fakeRes(false)
    const w = createSseWriter(res, 100)
    w('a'.repeat(60))
    w('b'.repeat(60)) // 累计 120 > 100
    expect(res.destroyCount).toBe(1)
    expect(res.destroyed).toBe(true)
    // 判死后继续写：静默丢弃（destroyed 守卫），不再 write 不再 destroy
    w('c'.repeat(10))
    expect(res.writes).toHaveLength(2)
    expect(res.destroyCount).toBe(1)
  })

  it('drain 事件复位累计（假死解除后不误判）', () => {
    const res = fakeRes(false)
    const w = createSseWriter(res, 100)
    w('a'.repeat(60))
    res.listeners.get('drain')!()
    w('b'.repeat(60)) // 复位后累计 60 ≤ 100
    expect(res.destroyCount).toBe(0)
  })

  it('writableEnded → 静默丢弃（既有守卫语义不变）', () => {
    const res = fakeRes(true)
    res.writableEnded = true
    const w = createSseWriter(res, 100)
    w('x')
    expect(res.writes).toHaveLength(0)
    expect(res.destroyCount).toBe(0)
  })
})

describe('createSseWriter / R64-26 连续滞留次数判死（仅心跳存活的假死连接）', () => {
  it('小包连续 false 超过 stuckLimit → destroy（字节闸需 ~25 天累计，次数闸 2 小时兜位）', () => {
    const res = fakeRes(false)
    const w = createSseWriter(res, 1_000_000, 240)
    for (let i = 0; i < 240; i++) w(': heartbeat\n\n') // 240 次：不过阈
    expect(res.destroyCount).toBe(0)
    w(': heartbeat\n\n') // 第 241 次
    expect(res.destroyCount).toBe(1)
    expect(res.destroyed).toBe(true)
  })

  it('drain 复位次数：假死解除后重新计数', () => {
    const res = fakeRes(false)
    const w = createSseWriter(res, 1_000_000, 5)
    for (let i = 0; i < 5; i++) w('x')
    expect(res.destroyCount).toBe(0) // 5 不超阈
    res.listeners.get('drain')!()
    for (let i = 0; i < 5; i++) w('x') // 复位后再 5 次：仍不过阈
    expect(res.destroyCount).toBe(0)
  })

  it('成功写复位次数（字节与次数双闸独立）', () => {
    const res = fakeRes(true)
    const w = createSseWriter(res, 1_000_000, 3)
    for (let i = 0; i < 100; i++) w('x')
    expect(res.destroyCount).toBe(0)
  })
})

// R65-42（总六十五轮）：字节闸按 UTF-8 实际字节计——原 chunk.length 是 UTF-16 码元
// 数，中文事件实际滞留约为计数 3 倍（1MB 阈值实际放行 ~3MB）。
describe('createSseWriter / R65-42 字节闸按 UTF-8 字节计（中文流不再漏判）', () => {
  it('中文滞留：码元数不过阈但字节数超阈 → destroy（修复前 chunk.length=1/字 漏判）', () => {
    const res = fakeRes(false)
    const w = createSseWriter(res, 200) // 阈值 200 字节
    const chunk = '中'.repeat(100) // 100 码元（旧口径 ≤ 200 不判死）/ 300 UTF-8 字节
    expect(Buffer.byteLength(chunk, 'utf8')).toBe(300)
    w(chunk)
    expect(res.destroyCount).toBe(1) // 字节口径：300 > 200 → 判死
    expect(res.destroyed).toBe(true)
  })

  it('混合内容按真实字节累计（跨调用累加口径不变）', () => {
    const res = fakeRes(false)
    const w = createSseWriter(res, 100)
    w('a'.repeat(40)) // 40 字节
    w('中'.repeat(20)) // +60 码元 / +60 字节 → 累计 100 字节 = 阈值，不超
    expect(res.destroyCount).toBe(0)
    w('中'.repeat(1)) // +3 字节 → 103 > 100
    expect(res.destroyCount).toBe(1)
  })
})
