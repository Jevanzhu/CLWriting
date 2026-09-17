/**
 * E1b（ring buffer 迟到回放）测试：cc driver 活跃执行事件 ring。
 * 验收：执行中新消费者加入 → 顺序回放 execRing（cap 协议单元）；
 *       执行终态后不重放历史；新执行清空 ring；超限只留最近 N 个。
 * 注意：async generator 惰性——stream() 调用不执行 body，消费者在首次 .next() 才加入；
 *       故先挂起消费者 A（genA.next() promise），再 emit，再加入消费者 B。
 */
import { test, expect } from 'vitest'
import { ccDriver, MAX_EXEC_RING } from '../../src/driver/cc.js'
import type { DriverEvent } from '../../src/driver/types.js'
import { sleep } from '../helpers/wait-for.js'

async function firstEvent(gen: AsyncGenerator<DriverEvent>): Promise<DriverEvent> {
  const r = await gen.next()
  if (r.done) throw new Error('stream 未产出事件')
  return r.value
}

test('E1b: 活跃执行中新消费者 B 加入 → 顺序回放 execRing', async () => {
  const session = await ccDriver.startSession('/tmp')
  // 消费者 A 先加入并挂起（无消费者期间接管 pre，此后事件进 execRing + 广播给 A）
  const genA = ccDriver.stream(session) as AsyncGenerator<DriverEvent>
  const pendingA = genA.next()
  ccDriver.emit!(session, { type: 'chat_start' })
  ccDriver.emit!(session, { type: 'chat_text', text: '第一段' })
  ccDriver.emit!(session, { type: 'chat_text', text: '第二段' })
  // 消费者 B 迟到加入 → 回放 execRing（0918独立重评修复批 E001：chat 腿活跃回放最前
  // 补一枚 chat_replay_begin 锚，其后 chat_start + 两段 text）
  const genB = ccDriver.stream(session) as AsyncGenerator<DriverEvent>
  const e1 = await firstEvent(genB)
  expect(e1.type).toBe('chat_replay_begin')
  const e2 = await genB.next()
  expect(e2.value.type).toBe('chat_start')
  const e3 = await genB.next()
  expect((e3.value as { text: string }).text).toBe('第一段')
  const e4 = await genB.next()
  expect((e4.value as { text: string }).text).toBe('第二段')
  await pendingA
  ccDriver.dispose(session)
})

test('E1b: 执行终态后新消费者不重放历史，只收后续新事件', async () => {
  const session = await ccDriver.startSession('/tmp')
  const genA = ccDriver.stream(session) as AsyncGenerator<DriverEvent>
  const pendingA = genA.next()
  ccDriver.emit!(session, { type: 'chat_start' })
  ccDriver.emit!(session, { type: 'chat_text', text: '旧内容' })
  ccDriver.emit!(session, { type: 'chat_done' }) // 执行终态
  // B 先挂起加入，再 emit 新事件 → B 只收新事件（不回放已结束执行）
  const genB = ccDriver.stream(session) as AsyncGenerator<DriverEvent>
  const pendingB = genB.next()
  ccDriver.emit!(session, { type: 'chat_text', text: '新内容' })
  const e1 = await pendingB
  expect((e1.value as { text: string }).text).toBe('新内容')
  await pendingA
  ccDriver.dispose(session)
})

test('E1b: 新执行开始清空 ring，只回放最新执行', async () => {
  const session = await ccDriver.startSession('/tmp')
  const genA = ccDriver.stream(session) as AsyncGenerator<DriverEvent>
  const pendingA = genA.next()
  ccDriver.emit!(session, { type: 'chat_start' })
  ccDriver.emit!(session, { type: 'chat_text', text: '第一轮旧' })
  ccDriver.emit!(session, { type: 'chat_done' })
  ccDriver.emit!(session, { type: 'chat_start' })
  ccDriver.emit!(session, { type: 'chat_text', text: '第二轮新' })
  const genB = ccDriver.stream(session) as AsyncGenerator<DriverEvent>
  // E001：chat 腿活跃回放最前补 chat_replay_begin 锚
  const e1 = await firstEvent(genB)
  expect(e1.type).toBe('chat_replay_begin')
  const e2 = await genB.next()
  expect(e2.value.type).toBe('chat_start')
  const e3 = await genB.next()
  expect((e3.value as { text: string }).text).toBe('第二轮新')
  await pendingA
  ccDriver.dispose(session)
})

test('E1b: ring cap 协议单元——超限只保留最近 N 个', async () => {
  const session = await ccDriver.startSession('/tmp')
  const genA = ccDriver.stream(session) as AsyncGenerator<DriverEvent>
  const pendingA = genA.next()
  ccDriver.emit!(session, { type: 'chat_start' })
  for (let i = 0; i < MAX_EXEC_RING + 10; i++) {
    ccDriver.emit!(session, { type: 'chat_text', text: '段' + i })
  }
  const genB = ccDriver.stream(session) as AsyncGenerator<DriverEvent>
  // cap=200 协议单元：chat_start + 210 text = 211，挤出前 11 个 → 回放从 段10 开始（chat_start 也被挤出）；
  // E001：chat 腿活跃回放最前补 chat_replay_begin 锚
  const e1 = await firstEvent(genB)
  expect(e1.type).toBe('chat_replay_begin')
  const e2 = await genB.next()
  expect((e2.value as { text: string }).text).toBe('段10')
  const texts: string[] = []
  for (let i = 0; i < MAX_EXEC_RING - 1; i++) {
    const r = await genB.next()
    texts.push((r.value as { text: string }).text)
  }
  expect(texts[MAX_EXEC_RING - 2]).toBe('段209')
  await pendingA
  ccDriver.dispose(session)
})

test('E1b: pre 语义保留——无消费者期间事件仍由首个消费者接管', async () => {
  const session = await ccDriver.startSession('/tmp')
  ccDriver.emit!(session, { type: 'chat_text', text: '暂存' })
  const gen = ccDriver.stream(session) as AsyncGenerator<DriverEvent>
  const e1 = await firstEvent(gen)
  expect((e1 as { text: string }).text).toBe('暂存')
  ccDriver.dispose(session)
})

test('AA-P3-2: pre 队列有 cap——无消费者超量事件只接管最近 N 个（防无限增堆）', async () => {
  const session = await ccDriver.startSession('/tmp')
  // 无消费者 emit 超量事件（> MAX_PRE_EVENTS = MAX_EXEC_RING）
  for (let i = 0; i < MAX_EXEC_RING + 10; i++) {
    ccDriver.emit!(session, { type: 'chat_text', text: '暂存' + i })
  }
  // 首个消费者只接管最近 N 个：cap=200 → 从 暂存10 开始（前 10 个被挤掉）
  const gen = ccDriver.stream(session) as AsyncGenerator<DriverEvent>
  const e1 = await firstEvent(gen)
  expect((e1 as { text: string }).text).toBe('暂存10')
  ccDriver.dispose(session)
})

test('AA-P3-3: 执行终态事件先入 ring 再关 active——活跃执行期间 ring 含终态锚', async () => {
  const session = await ccDriver.startSession('/tmp')
  const genA = ccDriver.stream(session) as AsyncGenerator<DriverEvent>
  const pendingA = genA.next()
  ccDriver.emit!(session, { type: 'chat_start' })
  ccDriver.emit!(session, { type: 'chat_text', text: '过程' })
  ccDriver.emit!(session, { type: 'chat_done' }) // 终态：先入 ring 再关 active
  // 消费 A 的完整流（含终态锚）——修复前 chat_done 不进 ring，但 A 是活连接经广播也能收到；
  // 关键不变式：ring 内容 = 完整执行（start/过程/done），新执行开始时才清空
  const a1 = await pendingA
  expect((a1.value as { type: string }).type).toBe('chat_start')
  const a2 = await genA.next()
  expect((a2.value as { text: string }).text).toBe('过程')
  const a3 = await genA.next()
  expect((a3.value as { type: string }).type).toBe('chat_done')
  await genA.return!({ type: 'notice', message: '' } as never)
  ccDriver.dispose(session)
})

// ---- execRing 分桶批（2026-09-17 单立清账）：chat 腿 / 写手腿各持独立 ring + active ----

test('execRing 分桶: chat 内嵌写章——写手腿并行不清 chat 腿、写手腿结束不灭 chat 腿', async () => {
  const session = await ccDriver.startSession('/tmp')
  const genA = ccDriver.stream(session) as AsyncGenerator<DriverEvent>
  const pendingA = genA.next()
  ccDriver.emit!(session, { type: 'chat_start' })
  ccDriver.emit!(session, { type: 'chat_text', text: '问' })
  // 内嵌 write_chapter 进行中重连：写手腿 EXEC_START（分桶前单环形态会清掉 chat 已积累段——丢段机理一）
  ccDriver.emit!(session, { type: 'role_spawn', role: 'writer', parentToolUseId: 'self-heal' })
  ccDriver.emit!(session, { type: 'text', text: '章内容' })
  // 迟到消费者 B1（两腿俱活跃）：回放 = chat_replay_begin 锚（E001）+ chat 段 + 写手段拼接
  // （桶间拼接序安全：前端按族分流）
  const genB1 = ccDriver.stream(session) as AsyncGenerator<DriverEvent>
  const got1: DriverEvent[] = []
  for (let i = 0; i < 5; i++) {
    const r = await genB1.next()
    if (r.done) throw new Error('回放不完整')
    got1.push(r.value)
  }
  expect(got1.map((e) => e.type)).toEqual(['chat_replay_begin', 'chat_start', 'chat_text', 'role_spawn', 'text'])
  await genB1.return(undefined)
  // 写手腿 EXEC_END（分桶前会置 execActive=false → 外层 chat 零回放——丢段机理二）
  ccDriver.emit!(session, { type: 'done', usage: 0, reason: 'success' })
  ccDriver.emit!(session, { type: 'chat_text', text: '答' })
  // 迟到消费者 B2（写手腿已结束、chat 腿仍活跃）：chat 段照常回放（含 done 后续增量）；
  // 写手段按「本腿结束不回放」锁定语义（r50-b3 b 组）不入回放
  const genB2 = ccDriver.stream(session) as AsyncGenerator<DriverEvent>
  const got2: DriverEvent[] = []
  for (let i = 0; i < 4; i++) {
    const r = await genB2.next()
    if (r.done) throw new Error('回放不完整')
    got2.push(r.value)
  }
  expect(got2.map((e) => e.type)).toEqual(['chat_replay_begin', 'chat_start', 'chat_text', 'chat_text'])
  expect((got2[2] as { text: string }).text).toBe('问')
  expect((got2[3] as { text: string }).text).toBe('答')
  await pendingA
  ccDriver.dispose(session)
})

test('execRing 分桶: 双桶 cap 独立——写手腿溢出裁剪不挤占 chat 腿（丢段机理三销案）', async () => {
  const session = await ccDriver.startSession('/tmp')
  const genA = ccDriver.stream(session) as AsyncGenerator<DriverEvent>
  const pendingA = genA.next()
  ccDriver.emit!(session, { type: 'chat_start' })
  ccDriver.emit!(session, { type: 'chat_text', text: 'c0' }) // chat 腿仅 2 条
  ccDriver.emit!(session, { type: 'role_spawn', role: 'writer', parentToolUseId: 'tu-1' })
  for (let i = 0; i < MAX_EXEC_RING + 10; i++) {
    ccDriver.emit!(session, { type: 'text', text: '段' + i }) // 写手腿 211 条 → 本腿 cap 200
  }
  const genB = ccDriver.stream(session) as AsyncGenerator<DriverEvent>
  // 回放 = chat 段完整（chat_start + c0）+ 写手段裁到最近 200（role_spawn 被挤出、段10 起）；
  // 拼接序列首 text 前无锚（chat_* 非锚、role_spawn 已被裁出）→ 前导合成 text_reset，
  // E001 锚在其后（chat 腿活跃回放最前插 chat_replay_begin）
  const e1 = await firstEvent(genB)
  expect(e1.type).toBe('text_reset')
  const e2 = await genB.next()
  expect(e2.value.type).toBe('chat_replay_begin')
  const e3 = await genB.next()
  expect(e3.value.type).toBe('chat_start')
  const e4 = await genB.next()
  expect((e4.value as { text: string }).text).toBe('c0')
  const e5 = await genB.next()
  expect((e5.value as { text: string }).text).toBe('段10')
  await pendingA
  ccDriver.dispose(session)
})

test('execRing 分桶: interrupted 全停——两腿齐关，迟到消费者零回放', async () => {
  const session = await ccDriver.startSession('/tmp')
  const genA = ccDriver.stream(session) as AsyncGenerator<DriverEvent>
  const pendingA = genA.next()
  ccDriver.emit!(session, { type: 'chat_start' })
  ccDriver.emit!(session, { type: 'role_spawn', role: 'writer', parentToolUseId: 'tu-1' })
  // 用户中断 = 全停语义（与 abortAllCtrls 同口径）：终态锚入所有活跃腿后关全部
  ccDriver.emit!(session, { type: 'interrupted', reason: 'user_cancel' })
  const genB = ccDriver.stream(session) as AsyncGenerator<DriverEvent>
  const r = await Promise.race([
    genB.next().then((n) => ({ kind: 'next' as const, n })),
    sleep(150).then(() => ({ kind: 'parked' as const })),
  ])
  expect(r.kind).toBe('parked')
  ccDriver.cancelStream?.(genB)
  await genB.return(undefined)
  await pendingA
  ccDriver.dispose(session)
})

