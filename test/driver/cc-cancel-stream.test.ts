/**
 * B-19（第六十轮补修）回归：driver stream 生成器断开即醒。
 *
 * 原先 SSE 断开后 `iter.return()` 只能在 yield 边界生效——生成器 park 在内部
 * `await new Promise(r => consumer.notify = r)` 上悬挂，直到该书下一 driver 事件
 * 到达才被推进回收（consumer 闭包滞留，KB 级/个；六十轮登记维持项，本次补修）。
 * 修复：Consumer 增 cancelled 标记 + cancelStream(iter) 唤醒句柄（WeakMap 登记），
 * stream.ts 断开侧先 cancelStream 再 iter.return。cc / mock 双 driver 同构。
 *
 * M-P2-1（内存核查 2026-08-25）回归：已连接消费者队列上限——慢/僵尸 SSE 消费者
 * （连接未断但生成器不再被拉动）在长流期间队列原先无限积压（pre/execRing 有 cap、
 * 广播腿漏掉）。修复：MAX_CONSUMER_QUEUE=200，超限丢最旧 + 补发一条 notice
 * （AA-P3-1：丢弃可感知）。cc / mock 双 driver 同构。
 */
import { tmpdir } from 'node:os'
import { describe, it, expect } from 'vitest'
import { ccDriver, MAX_CONSUMER_QUEUE as CC_MAX_CONSUMER_QUEUE } from '../../src/driver/cc.js'
import { mockDriver, MAX_CONSUMER_QUEUE as MOCK_MAX_CONSUMER_QUEUE } from '../../src/driver/mock.js'
import type { StudioDriver, DriverEvent } from '../../src/driver/types.js'

const drivers: [string, StudioDriver][] = [
  ['ccDriver', ccDriver],
  ['mockDriver', mockDriver],
]

/** M-P2-1：driver + 各自导出的队列上限（cc/mock 各自导出锚定，防两处漂移） */
const capDrivers: [string, StudioDriver, number][] = [
  ['ccDriver', ccDriver, CC_MAX_CONSUMER_QUEUE],
  ['mockDriver', mockDriver, MOCK_MAX_CONSUMER_QUEUE],
]

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** 推进 iter 直到它 park 在内部 await。返回**对象包裹**的悬置 next()——async 函数
 *  返回裸 Promise 会被展平，调用方 await 会变成等生成器自身 settle（无事件即挂死） */
async function untilParked(iter: AsyncGenerator<DriverEvent>): Promise<{ parked: Promise<IteratorResult<DriverEvent>> }> {
  let pending = iter.next()
  for (;;) {
    const raced = await Promise.race([
      pending.then((r) => ({ kind: 'value' as const, r })),
      // R61-19（第六十一轮）：30ms 判「已 park」在极端慢机可假红（事件到得慢被误判
      // parked，断言少一条事件）——150ms fail-safe 加余量，语义不变。
      // R63-16：评估后维持——「区分 park 与慢事件」本质靠超时启发式，无确定性替身；
      // 再加宽按每次 park 线性付运行时代价，150ms 自 R61-19 起零假红，登记维持
      sleep(150).then(() => ({ kind: 'parked' as const })),
    ])
    if (raced.kind === 'parked') return { parked: pending }
    if (raced.r.done) throw new Error('生成器意外提前完成')
    pending = iter.next()
  }
}

/** 从既有的悬置 next() 起收尽队列积压（再次 park 前的全部事件）——M-P2-1 断言
 *  「收到的 = 积压队列全量」，据此观测封顶/丢最旧/notice 补发。返回收尾时悬置的
 *  next()（多轮积压用例接力：直接作下一轮的 first，不得另起 next()——async
 *  generator 的请求按序排队，另起的会排在前一个悬置 next() 之后、漏收首事件） */
async function collectUntilParked(
  iter: AsyncGenerator<DriverEvent>,
  first: Promise<IteratorResult<DriverEvent>>,
): Promise<{ collected: DriverEvent[]; parked: Promise<IteratorResult<DriverEvent>> }> {
  const out: DriverEvent[] = []
  let pending = first
  for (;;) {
    const raced = await Promise.race([
      pending.then((r) => ({ kind: 'value' as const, r })),
      // R61-19 + R63-16：150ms park fail-safe（同上 untilParked，评估后维持）
      sleep(150).then(() => ({ kind: 'parked' as const })),
    ])
    if (raced.kind === 'parked') return { collected: out, parked: pending }
    if (raced.r.done) throw new Error('生成器意外完成（未预期）')
    out.push(raced.r.value)
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

describe.each(capDrivers)('M-P2-1: %s 已连接消费者队列上限', (_name, driver, maxQueue) => {
  it('慢消费者（只连不拉）持续 emit 超上限：队列封顶、丢最旧、补发 notice', async () => {
    const session = await driver.startSession(tmpdir())
    try {
      const iter = driver.stream(session) as AsyncGenerator<DriverEvent>
      // 「只连不拉」：驱动到注册 + park 后不再拉动（模拟网络停滞的 SSE 连接——
      // 连接未断、cancelStream 不会触发，只能靠队列 cap 兜底）
      const { parked } = await untilParked(iter)
      const total = maxQueue + 50
      for (let i = 0; i < total; i++) {
        driver.emit!(session, { type: 'text', text: `ev-${i}` })
      }
      // 唤醒后一次性收尽积压：收到的 = 队列内容全量（封顶观测面）
      const { collected } = await collectUntilParked(iter, parked)
      // R73-9（二十一轮 A-9）：notice 走「容量 +1 内部槽」——真实事件仍精确封顶
      // maxQueue，notice 是 +1 槽（修复前 notice 挤占真实事件位，首轮溢出连丢 2 条真实事件）
      expect(collected).toHaveLength(maxQueue + 1)
      const texts = collected
        .filter((e) => e.type === 'text')
        .map((e) => (e as { text: string }).text)
      expect(texts).toHaveLength(maxQueue) // 真实事件恰好 maxQueue 条（每次溢出只丢 1 条最旧）
      expect(texts).not.toContain('ev-0') // 最旧已丢（修复前 ev-0 仍在队首）
      expect(texts).toContain(`ev-${total - 1}`) // 最新事件照常送达
      // 幸存事件保序（丢的是队头连续一段，不是乱序抽丢）
      const idx = texts.map((t) => Number(t.slice('ev-'.length)))
      expect([...idx].sort((a, b) => a - b)).toEqual(idx)
      // 补发 notice（AA-P3-1：丢弃可感知）——至少一条，消息明言丢弃
      const notices = collected.filter((e) => e.type === 'notice')
      expect(notices.length).toBeGreaterThanOrEqual(1)
      expect((notices[0] as { message: string }).message).toContain('丢弃')
    } finally {
      driver.dispose(session)
    }
  })

  it('队列拉空后告知标记复位：第二轮积压再超限重新补发 notice', async () => {
    const session = await driver.startSession(tmpdir())
    try {
      const iter = driver.stream(session) as AsyncGenerator<DriverEvent>
      const { parked } = await untilParked(iter)
      // 第一轮积压：超限 → 补发 notice
      for (let i = 0; i < maxQueue + 10; i++) {
        driver.emit!(session, { type: 'text', text: `r1-${i}` })
      }
      const r1 = await collectUntilParked(iter, parked)
      expect(r1.collected.filter((e) => e.type === 'notice')).toHaveLength(1)
      // 拉空后第二轮积压：dropNotified 已复位 → 重新补发一条（而非永久沉默）。
      // 接力上一轮收尾时悬置的 next()（另起 untilParked 会漏收第二轮首事件）
      for (let i = 0; i < maxQueue + 10; i++) {
        driver.emit!(session, { type: 'text', text: `r2-${i}` })
      }
      const r2 = await collectUntilParked(iter, r1.parked)
      // R73-9：maxQueue 条真实事件 + 1 条 notice 内部槽
      expect(r2.collected).toHaveLength(maxQueue + 1)
      expect(r2.collected.filter((e) => e.type === 'notice')).toHaveLength(1)
    } finally {
      driver.dispose(session)
    }
  })
})
