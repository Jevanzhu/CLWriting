/**
 * mock driver 契约测试(横切 P0):验证 mockDriver 事件序列符合 StudioDriver 契约。
 *
 * 不调任何大模型(纯 mock),验证:init / emit(自定义事件回流)/ dispose。
 * 前端用 mock 开发时契约正确性由此保证。
 */
import { describe, it, expect } from 'vitest'
import { mockDriver } from '../../src/driver/mock.js'
import type { DriverEvent } from '../../src/driver/types.js'

interface S {
  closed: boolean
  id: string
  cwd: string
}

async function collect(session: S, until: (ev: DriverEvent) => boolean): Promise<DriverEvent[]> {
  const out: DriverEvent[] = []
  for await (const ev of mockDriver.stream(session)) {
    out.push(ev)
    if (until(ev)) break
  }
  return out
}

describe('mock driver 契约', () => {
  it('startSession → init(含 agents 清单)', async () => {
    const session = (await mockDriver.startSession('/tmp')) as S
    const events = await collect(session, (ev) => ev.type === 'init')
    mockDriver.dispose(session)
    expect(events[0]?.type).toBe('init')
    expect((events[0] as { agents?: string[] }).agents).toContain('writer')
  })

  it('emit → 自定义事件进流(编排层回推 self-heal 等事件)', async () => {
    const session = (await mockDriver.startSession('/tmp')) as S
    await collect(session, (ev) => ev.type === 'init') // 排空 init
    // 消费者在线时 emit → 事件进流（Bug A 修复后：emit 需有活跃消费者才送达）
    const gen = mockDriver.stream(session) as AsyncGenerator<DriverEvent>
    const firstEv = gen.next()
    mockDriver.emit?.(session, { type: 'self_heal_phase', phase: 'drafting', attempt: 1 })
    mockDriver.emit?.(session, { type: 'done', cost: 0, usage: 0, reason: 'success' })
    const e1 = await firstEv
    const e2 = await gen.next()
    mockDriver.dispose(session)
    expect((e1.value as { type: string }).type).toBe('self_heal_phase')
    expect((e2.value as { type: string }).type).toBe('done')
  })

  it('dispose 后 session.closed = true', async () => {
    const session = (await mockDriver.startSession('/tmp')) as S
    mockDriver.dispose(session)
    expect(session.closed).toBe(true)
  })

  it('Bug A 回归: 多消费者广播——每个 SSE 连接都收到全部事件(不被单消费者 shift 分散)', async () => {
    const session = (await mockDriver.startSession('/tmp')) as S
    // 排空 startSession 的 init
    await collect(session, (ev) => ev.type === 'init')

    // 两个并发消费者模拟 前端 + 调试 curl 双 SSE 连接
    const done1 = new Promise<DriverEvent[]>((resolve) => {
      const out: DriverEvent[] = []
      void (async () => {
        for await (const ev of mockDriver.stream(session)) {
          out.push(ev)
          if (ev.type === 'done') resolve(out)
        }
      })()
    })
    const done2 = new Promise<DriverEvent[]>((resolve) => {
      const out: DriverEvent[] = []
      void (async () => {
        for await (const ev of mockDriver.stream(session)) {
          out.push(ev)
          if (ev.type === 'done') resolve(out)
        }
      })()
    })

    // emit 一串事件（模拟 self-heal 闭环）
    mockDriver.emit?.(session, { type: 'self_heal_phase', phase: 'drafting', attempt: 1 })
    mockDriver.emit?.(session, { type: 'self_heal_phase', phase: 'checking', attempt: 0 })
    mockDriver.emit?.(session, { type: 'done', cost: 0, usage: 0, reason: 'success' })

    const [e1, e2] = await Promise.all([done1, done2])
    mockDriver.dispose(session)

    // 两个消费者都必须收到完整序列(不被分散)
    const types1 = e1.map((e) => e.type)
    const types2 = e2.map((e) => e.type)
    expect(types1).toEqual(['self_heal_phase', 'self_heal_phase', 'done'])
    expect(types2).toEqual(['self_heal_phase', 'self_heal_phase', 'done'])
  })

  it('Bug A 回归: 中间加入的消费者只收后续事件,不重放历史', async () => {
    const session = (await mockDriver.startSession('/tmp')) as S
    await collect(session, (ev) => ev.type === 'init')

    // 先发两个事件
    mockDriver.emit?.(session, { type: 'self_heal_phase', phase: 'drafting', attempt: 1 })
    mockDriver.emit?.(session, { type: 'self_heal_phase', phase: 'checking', attempt: 0 })

    // 中间加入的消费者
    const done = new Promise<DriverEvent[]>((resolve) => {
      const out: DriverEvent[] = []
      void (async () => {
        for await (const ev of mockDriver.stream(session)) {
          out.push(ev)
          if (ev.type === 'done') resolve(out)
        }
      })()
    })

    mockDriver.emit?.(session, { type: 'done', cost: 0, usage: 0, reason: 'success' })
    const events = await done
    mockDriver.dispose(session)

    // 只收到加入后的 done,不重放靠前的 drafting/checking
    expect(events.map((e) => e.type)).toEqual(['done'])
  })

  it('AA-P3-2 同构: 无消费者期间 pre 暂存上限 200——超出只留最近 N 个', async () => {
    const session = (await mockDriver.startSession('/tmp')) as S
    // init 已进 pre（1 条）；再无消费者连发 205 条 → pre 上限 200，
    // 挤掉最早的 6 条（init + attempt 1..5），首消费者只接管最近 200 个
    for (let i = 1; i <= 205; i++) {
      mockDriver.emit?.(session, { type: 'self_heal_phase', phase: 'drafting', attempt: i })
    }
    const gen = mockDriver.stream(session) as AsyncGenerator<DriverEvent>
    const evs: DriverEvent[] = []
    for (let i = 0; i < 200; i++) {
      const r = await gen.next()
      if (r.done) break
      evs.push(r.value)
    }
    mockDriver.dispose(session)
    expect(evs).toHaveLength(200)
    expect((evs[0] as { attempt?: number }).attempt).toBe(6)
    expect((evs[199] as { attempt?: number }).attempt).toBe(205)
  })
})