/**
 * 0918独立重评修复批（E001）回归：cc driver 迟到回放的对话腿锚 chat_replay_begin。
 *
 * 现状：execRing 重连回放把 chat 腿 ring（chat_turn/chat_text 等）原样重放，前端在
 * 已有在途气泡上再收 chat_turn 会产生重复气泡。修法：chat 腿活跃且其 ring 非空时，
 * 在回放数组最前（chat ring 段之前）插一枚无载荷 chat_replay_begin；仅写手腿回放
 * （chat 腿不活跃）不插。断言面：
 * 1. chat 腿活跃回放 → 序列头恰一枚 chat_replay_begin 且在 chat 事件前；
 * 2. 仅写手腿活跃 → 无该事件；
 * 3. chat 腿活跃 ring 空 → 无该事件（纯函数面——「活跃且 ring 空」经公共 emit 面
 *    不可达：EXEC_START 必随 chat_start 入环，cap 只裁不清，黑盒无此态）；
 * 4. 两腿都活跃 → 恰一枚、位于全部回放前；
 * 5. 前导清屏锚（replayNeedsResetAnchor 锚单判）不受新事件影响：chat_replay_begin
 *    既非 text 也非清屏锚，扫描逐事件判定语义不变。
 */
import { test, expect } from 'vitest'
import { ccDriver, buildRingReplay } from '../../src/driver/cc.js'
import type { DriverEvent } from '../../src/driver/types.js'

async function firstEvent(gen: AsyncGenerator<DriverEvent>): Promise<DriverEvent> {
  const r = await gen.next()
  if (r.done) throw new Error('stream 未产出事件')
  return r.value
}

test('E001: chat 腿活跃回放 → 首事件恰一枚 chat_replay_begin，其后才是 chat 事件', async () => {
  const session = await ccDriver.startSession('/tmp')
  const genA = ccDriver.stream(session) as AsyncGenerator<DriverEvent>
  const pendingA = genA.next() // 消费者 A 占位（此后事件进 chat 腿 ring + 广播）
  ccDriver.emit!(session, { type: 'chat_start' })
  ccDriver.emit!(session, { type: 'chat_turn', turn: 0 })
  ccDriver.emit!(session, { type: 'chat_text', text: '对话增量' })
  // 迟到消费者 B：回放 = chat_replay_begin + chat 腿 ring
  const genB = ccDriver.stream(session) as AsyncGenerator<DriverEvent>
  const e1 = await firstEvent(genB)
  expect(e1.type).toBe('chat_replay_begin')
  const e2 = await genB.next()
  expect(e2.value.type).toBe('chat_start')
  const e3 = await genB.next()
  expect((e3.value as { turn: number }).turn).toBe(0)
  const e4 = await genB.next()
  expect((e4.value as { text: string }).text).toBe('对话增量')
  // 精准性：锚恰一枚——其后紧邻 chat_start，无第二枚
  await pendingA
  ccDriver.dispose(session)
})

test('E001: 仅写手腿活跃 → 无 chat_replay_begin（写手段回放照旧）', async () => {
  const session = await ccDriver.startSession('/tmp')
  const genA = ccDriver.stream(session) as AsyncGenerator<DriverEvent>
  const pendingA = genA.next()
  ccDriver.emit!(session, { type: 'role_spawn', role: 'writer', parentToolUseId: 'tu-1' })
  ccDriver.emit!(session, { type: 'text', text: '写手增量' })
  const genB = ccDriver.stream(session) as AsyncGenerator<DriverEvent>
  const e1 = await firstEvent(genB)
  expect(e1.type).toBe('role_spawn')
  const e2 = await genB.next()
  expect((e2.value as { text: string }).text).toBe('写手增量')
  await pendingA
  ccDriver.dispose(session)
})

test('E001: chat 腿活跃 ring 空 → 无 chat_replay_begin（纯函数面）', () => {
  // 黑盒不可达态（见文件头注 3）经导出纯函数锁定守卫语义
  const replay = buildRingReplay({ ring: [], active: true }, { ring: [], active: false })
  expect(replay).toEqual([])
  expect(replay.some((e) => e.type === 'chat_replay_begin')).toBe(false)
})

test('E001: 两腿都活跃 → 恰一枚锚、位于全部回放前（chat 段 + 写手段）', async () => {
  const session = await ccDriver.startSession('/tmp')
  const genA = ccDriver.stream(session) as AsyncGenerator<DriverEvent>
  const pendingA = genA.next()
  ccDriver.emit!(session, { type: 'chat_start' })
  ccDriver.emit!(session, { type: 'chat_text', text: '问' })
  // 内嵌写章（写手腿开跑）——两腿俱活跃
  ccDriver.emit!(session, { type: 'role_spawn', role: 'writer', parentToolUseId: 'self-heal' })
  ccDriver.emit!(session, { type: 'text', text: '章内容' })
  const genB = ccDriver.stream(session) as AsyncGenerator<DriverEvent>
  const got: DriverEvent[] = []
  for (let i = 0; i < 5; i++) {
    const r = await genB.next()
    if (r.done) throw new Error('回放不完整')
    got.push(r.value)
  }
  expect(got.map((e) => e.type)).toEqual([
    'chat_replay_begin',
    'chat_start',
    'chat_text',
    'role_spawn',
    'text',
  ])
  // 恰一枚：全序列仅首枚
  expect(got.filter((e) => e.type === 'chat_replay_begin')).toHaveLength(1)
  await pendingA
  ccDriver.dispose(session)
})

test('E001: 锚单判不受影响——chat 腿 ring 在场时回放前导不补 text_reset（chat_* 无 text 事件）', async () => {
  const session = await ccDriver.startSession('/tmp')
  const genA = ccDriver.stream(session) as AsyncGenerator<DriverEvent>
  const pendingA = genA.next()
  ccDriver.emit!(session, { type: 'chat_start' })
  ccDriver.emit!(session, { type: 'chat_text', text: '对话增量' })
  const genB = ccDriver.stream(session) as AsyncGenerator<DriverEvent>
  // 首事件是 chat_replay_begin 而非 text_reset：新锚对 replayNeedsResetAnchor 透明
  // （既非 text 也非 TEXTOUT_ANCHORS，扫描继续——与修复前单判结果一致）
  const e1 = await firstEvent(genB)
  expect(e1.type).toBe('chat_replay_begin')
  const e2 = await genB.next()
  expect(e2.value.type).toBe('chat_start')
  await pendingA
  ccDriver.dispose(session)
})
