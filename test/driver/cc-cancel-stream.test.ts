/**
 * B-19（第六十轮补修）回归：driver stream 生成器断开即醒。
 *
 * 原先 SSE 断开后 `iter.return()` 只能在 yield 边界生效——生成器 park 在内部
 * `await new Promise(r => consumer.notify = r)` 上悬挂，直到该书下一 driver 事件
 * 到达才被推进回收（consumer 闭包滞留，KB 级/个；六十轮登记维持项，本次补修）。
 * 修复：Consumer 增 cancelled 标记 + cancelStream(iter) 唤醒句柄（WeakMap 登记），
 * stream.ts 断开侧先 cancelStream 再 iter.return。cc / mock 双 driver 同构。
 */
import { tmpdir } from 'node:os'
import { describe, it, expect } from 'vitest'
import { ccDriver } from '../../src/driver/cc.js'
import { mockDriver } from '../../src/driver/mock.js'
import type { StudioDriver, DriverEvent } from '../../src/driver/types.js'

const drivers: [string, StudioDriver][] = [
  ['ccDriver', ccDriver],
  ['mockDriver', mockDriver],
]

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** 推进 iter 直到它 park 在内部 await。返回**对象包裹**的悬置 next()——async 函数
 *  返回裸 Promise 会被展平，调用方 await 会变成等生成器自身 settle（无事件即挂死） */
async function untilParked(iter: AsyncGenerator<DriverEvent>): Promise<{ parked: Promise<IteratorResult<DriverEvent>> }> {
  let pending = iter.next()
  for (;;) {
    const raced = await Promise.race([
      pending.then((r) => ({ kind: 'value' as const, r })),
      sleep(30).then(() => ({ kind: 'parked' as const })),
    ])
    if (raced.kind === 'parked') return { parked: pending }
    if (raced.r.done) throw new Error('生成器意外提前完成')
    pending = iter.next()
  }
}

describe.each(drivers)('B-19: %s stream 断开即醒', (_name, driver) => {
  it('park 中的生成器经 cancelStream 立即完成（不等该书下一事件）', async () => {
    const session = await driver.startSession(tmpdir())
    try {
      const iter = driver.stream(session) as AsyncGenerator<DriverEvent>
      const { parked } = await untilParked(iter) // 悬置在内部 await（修复前 return 推不动它）
      expect(driver.cancelStream).toBeTruthy()
      driver.cancelStream!(iter)
      const r = await parked // 修复前：悬挂到下一 driver 事件（本用例不 emit → 测试超时红）
      expect(r.done).toBe(true)
      // 收尾不悬挂：return 兜底也立即 settle
      await iter.return(undefined)
    } finally {
      driver.dispose(session)
    }
  })

  it('多消费者隔离：取消其一不影响其他消费者继续收事件', async () => {
    const session = await driver.startSession(tmpdir())
    try {
      const s1 = driver.stream(session) as AsyncGenerator<DriverEvent>
      const s2 = driver.stream(session) as AsyncGenerator<DriverEvent>
      const { parked: p1 } = await untilParked(s1)
      const { parked: p2 } = await untilParked(s2)
      driver.cancelStream!(s1)
      expect((await p1).done).toBe(true)
      // s2 不受影响：emit 后仍能收到（s1 的 consumer 已在 finally 摘除）
      driver.emit!(session, { type: 'interrupted', reason: 'b19-test' })
      const ev = await p2
      expect(ev.done).toBeFalsy()
      expect((ev.value as { type: string }).type).toBe('interrupted')
    } finally {
      driver.dispose(session)
    }
  })

  it('取消不吞已入队事件：先发完队列再自行收尾', async () => {
    const session = await driver.startSession(tmpdir())
    try {
      driver.emit!(session, { type: 'interrupted', reason: 'queued' })
      const iter = driver.stream(session) as AsyncGenerator<DriverEvent>
      driver.cancelStream!(iter) // 尚未开始迭代：仅置标记
      // mock 的 startSession 已暂存 init 进 pre——入队事件按序完整发出，只断言
      // 「我 emit 的事件在发完的队列里」且随后立即 done（不吞不滞）
      const seen: string[] = []
      for (;;) {
        const r = await iter.next()
        if (r.done) break
        seen.push((r.value as { type: string }).type)
      }
      expect(seen).toContain('interrupted')
      expect(seen[seen.length - 1]).toBe('interrupted')
    } finally {
      driver.dispose(session)
    }
  })
})
