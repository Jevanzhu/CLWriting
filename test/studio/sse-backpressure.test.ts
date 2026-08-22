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
