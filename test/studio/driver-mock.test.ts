/**
 * mock driver 契约测试(横切 P0):验证 mockDriver 事件序列符合 StudioDriver 契约。
 *
 * 不调任何大模型(纯 mock),验证:init / spawnRole(无 role_spawn)/ send(有 role_spawn)/
 * text 分块 / usage / done 序列。前端用 mock 开发时契约正确性由此保证。
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

  it('spawnRole(writer) → text 分块 + usage + done(无 role_spawn,干净上下文)', async () => {
    const session = (await mockDriver.startSession('/tmp')) as S
    await collect(session, (ev) => ev.type === 'init') // 排空 init
    mockDriver.spawnRole(session, 'writer', '写第1章正文')
    const events = await collect(session, (ev) => ev.type === 'done')
    mockDriver.dispose(session)
    const types = events.map((e) => e.type)
    expect(types).not.toContain('role_spawn') // spawnRole 模式干净,无 role_spawn
    expect(types.filter((t) => t === 'text').length).toBeGreaterThan(0)
    expect(types).toContain('usage')
    expect(types.at(-1)).toBe('done')
  })

  it('send(main) → role_spawn + text + usage + done', async () => {
    const session = (await mockDriver.startSession('/tmp')) as S
    await collect(session, (ev) => ev.type === 'init')
    mockDriver.send(session, '合成细纲')
    const events = await collect(session, (ev) => ev.type === 'done')
    mockDriver.dispose(session)
    const types = events.map((e) => e.type)
    expect(types).toContain('role_spawn') // send 模式有 role_spawn
    expect(types.filter((t) => t === 'text').length).toBeGreaterThan(0)
    expect(types).toContain('usage')
    expect(types.at(-1)).toBe('done')
  })

  it('dispose 后 session.closed = true', async () => {
    const session = (await mockDriver.startSession('/tmp')) as S
    mockDriver.dispose(session)
    expect(session.closed).toBe(true)
  })
})
