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
    mockDriver.emit?.(session, { type: 'self_heal_phase', phase: 'drafting', attempt: 1 })
    mockDriver.emit?.(session, { type: 'done', cost: 0, usage: 0, reason: 'success' })
    const events = await collect(session, (ev) => ev.type === 'done')
    mockDriver.dispose(session)
    const types = events.map((e) => e.type)
    expect(types[0]).toBe('self_heal_phase')
    expect(types.at(-1)).toBe('done')
  })

  it('dispose 后 session.closed = true', async () => {
    const session = (await mockDriver.startSession('/tmp')) as S
    mockDriver.dispose(session)
    expect(session.closed).toBe(true)
  })
})