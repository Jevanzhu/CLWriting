/**
 * R-P1-1（2026-09-08 全量代码重审 批1）回归：迟到回放的前导清屏锚。
 *
 * 原状：E1b 迟到回放（pre 首消费者接管 / execRing 活跃执行重放）把 text 增量原样
 * 重发给新消费者，workbench.dispatch 盲追加（textOut += text）——断连重连的消费者
 * 已积累的 textOut 与重放增量叠加即整段重复。pre/execRing 双 cap（=200 协议单元）
 * 溢出时回放头部的自然锚（role_spawn/text_reset）必被挤出——chapter 级生成每 delta
 * 一协议单元，溢出是常态而非边角。
 * 修法：回放序列首个 text 增量之前无清屏锚（role_spawn/init/text_reset/self_heal_reset）
 * 时，回放前补发合成 text_reset，重放文本从空重建（helper 见 src/driver/replay-anchor.ts，
 * cc/mock 两 driver 同构接线）。
 *
 * 断言面：
 * 1. execRing 溢出 → 迟到消费者首事件 = text_reset，其后才是回放增量；
 * 2. 锚仍在回放内（未溢出）→ 不补发（首事件 = role_spawn，回放零多余事件——精准性）；
 * 3. 回放无 text 型事件（chat_text 等）→ 不补发（既有 cc-ring 用例同面，此处显式锁定）；
 * 4. cc pre 溢出 → 首消费者首事件 = text_reset；
 * 5. mock pre 溢出（init 锚被挤出）→ 首事件 = text_reset（两 driver 契约同构）。
 */
import { test, expect } from 'vitest'
import { ccDriver, MAX_EXEC_RING } from '../../src/driver/cc.js'
import { mockDriver } from '../../src/driver/mock.js'
import type { DriverEvent } from '../../src/driver/types.js'

async function firstEvent(gen: AsyncGenerator<DriverEvent>): Promise<DriverEvent> {
  const r = await gen.next()
  if (r.done) throw new Error('stream 未产出事件')
  return r.value
}

test('R-P1-1: execRing 溢出挤出自然锚 → 迟到消费者首事件为合成 text_reset', async () => {
  const session = await ccDriver.startSession('/tmp')
  const genA = ccDriver.stream(session) as AsyncGenerator<DriverEvent>
  const pendingA = genA.next() // 消费者 A 挂起占位（此后事件进 execRing + 广播）
  ccDriver.emit!(session, { type: 'role_spawn', role: 'writer', parentToolUseId: 'tu-1' })
  ccDriver.emit!(session, { type: 'text_reset' })
  for (let i = 0; i < MAX_EXEC_RING + 10; i++) {
    ccDriver.emit!(session, { type: 'text', text: '段' + i })
  }
  // ring = text_reset + 210 delta = 211 > 200 → role_spawn/text_reset/段0~段9 被挤出；
  // 修复前回放首事件 = 「段10」（重连即重复拼接）；修复后回放前补发合成 text_reset
  const genB = ccDriver.stream(session) as AsyncGenerator<DriverEvent>
  const e1 = await firstEvent(genB)
  expect(e1.type).toBe('text_reset')
  const e2 = await genB.next()
  expect((e2.value as { text: string }).text).toBe('段10')
  await pendingA
  ccDriver.dispose(session)
})

test('R-P1-1: 自然锚仍在回放内（未溢出）→ 不补发，首事件保持 role_spawn', async () => {
  const session = await ccDriver.startSession('/tmp')
  const genA = ccDriver.stream(session) as AsyncGenerator<DriverEvent>
  const pendingA = genA.next()
  ccDriver.emit!(session, { type: 'role_spawn', role: 'writer', parentToolUseId: 'tu-1' })
  ccDriver.emit!(session, { type: 'text', text: '增量一' })
  ccDriver.emit!(session, { type: 'text', text: '增量二' })
  const genB = ccDriver.stream(session) as AsyncGenerator<DriverEvent>
  const e1 = await firstEvent(genB)
  expect(e1.type).toBe('role_spawn')
  // 精准性：回放零多余事件——锚在场时不插合成 reset
  const e2 = await genB.next()
  expect((e2.value as { text: string }).text).toBe('增量一')
  const e3 = await genB.next()
  expect((e3.value as { text: string }).text).toBe('增量二')
  await pendingA
  ccDriver.dispose(session)
})

test('R-P1-1: 回放无 text 型事件（chat_* 等）→ 不补发（chat 域不受清屏锚影响）', async () => {
  const session = await ccDriver.startSession('/tmp')
  const genA = ccDriver.stream(session) as AsyncGenerator<DriverEvent>
  const pendingA = genA.next()
  ccDriver.emit!(session, { type: 'chat_start' })
  ccDriver.emit!(session, { type: 'chat_text', text: '对话增量' })
  const genB = ccDriver.stream(session) as AsyncGenerator<DriverEvent>
  const e1 = await firstEvent(genB)
  expect(e1.type).toBe('chat_start')
  const e2 = await genB.next()
  expect((e2.value as { text: string }).text).toBe('对话增量')
  await pendingA
  ccDriver.dispose(session)
})

test('R-P1-1: cc pre 溢出挤出自然锚 → 首个消费者首事件为合成 text_reset', async () => {
  const session = await ccDriver.startSession('/tmp')
  // 无消费者 emit：role_spawn + text_reset + 超量 text → pre cap 只留最近 200
  ccDriver.emit!(session, { type: 'role_spawn', role: 'writer', parentToolUseId: 'tu-1' })
  ccDriver.emit!(session, { type: 'text_reset' })
  for (let i = 0; i < MAX_EXEC_RING + 10; i++) {
    ccDriver.emit!(session, { type: 'text', text: '暂存' + i })
  }
  const gen = ccDriver.stream(session) as AsyncGenerator<DriverEvent>
  const e1 = await firstEvent(gen)
  expect(e1.type).toBe('text_reset')
  const e2 = await gen.next()
  expect((e2.value as { text: string }).text).toBe('暂存10')
  ccDriver.dispose(session)
})

test('R-P1-1: mock pre 溢出挤出 init 锚 → 首事件为合成 text_reset（两 driver 同构）', async () => {
  const session = await mockDriver.startSession('/tmp')
  // mock startSession 已推 init（自然锚）进 pre；超量 text 挤出 init
  for (let i = 0; i < MAX_EXEC_RING + 10; i++) {
    mockDriver.emit!(session, { type: 'text', text: '模拟' + i })
  }
  const gen = mockDriver.stream(session) as AsyncGenerator<DriverEvent>
  const e1 = await firstEvent(gen)
  expect(e1.type).toBe('text_reset')
  const e2 = await gen.next()
  expect((e2.value as { text: string }).text).toBe('模拟10')
  mockDriver.dispose(session)
})
