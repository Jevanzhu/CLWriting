/**
 * R50-B-3（五十轮）：cc driver 精密行为回归网。
 *
 * 清单三条中 a) 队列 cap 溢出丢最旧 + notice 一次性（R73-9「容量+1 内部槽」）经核对
 * 已由 cc-cancel-stream.test.ts 的「M-P2-1 已连接消费者队列上限」describe 精确覆盖
 * （含 R73-9 maxQueue+1 断言、ev-0 丢弃、notice 恰 1 条、「拉空复位后第二轮重新补发」
 * 两个用例）——本轮不重复建设，如实报告。
 *
 * 本文件补：
 * - b) E1b execRing 迟到回放：执行中迟到的消费者（pre 已被接管）回放最近
 *   MAX_EXEC_RING(200) 条协议单元（cap 裁剪 + 保序）；EXEC_START 清空重开；
 *   执行结束（execActive=false）后接入不回放——现状语义锁定。AA-P3-3 的「终态先入
 *   ring」在当前回放条件（execActive=true 才回放）下无黑盒观测面：终态 emit 同步
 *   置 false，此后接入的消费者走不到 ring 回放分支，终态锚行为以源码注释为准
 *   （防未来回放面扩展时误删终态入 ring 逻辑，见 cc.ts AA-P3-3 注）。
 * - c) M-1 owner 分槽 ctrl：P2-6 同 owner 换新先 abort 旧 / 同一 ctrl 重复登记幂等 /
 *   跨 owner（chat × self-heal）并存不互掐 / X-P2-11 终态注销只抹自己 / interrupt 全停。
 *
 * mock driver 无 execRing、registerCtrl 为 noop（见 mock.ts 头注），b/c 仅测 ccDriver。
 */
import { tmpdir } from 'node:os'
import { describe, it, expect } from 'vitest'
import { ccDriver, MAX_EXEC_RING } from '../../src/driver/cc.js'
import type { DriverEvent } from '../../src/driver/types.js'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** 推一个接管 pre 的消费者（拿走首事件后断开）——置 preTaken=true，使后续迟到
 *  消费者走 execRing 回放分支（模拟「首个消费者早已来过又走」的重连形态） */
async function takePreThenLeave(session: Awaited<ReturnType<typeof ccDriver.startSession>>): Promise<void> {
  ccDriver.emit?.(session, { type: 'text', text: 'pre-seed' }) // 无消费者：进 pre（execActive=false 不入 ring）
  const first = ccDriver.stream(session) as AsyncGenerator<DriverEvent>
  const r = await first.next() // 启动生成器：注册 consumer + 接管 pre（preTaken=true）
  expect(r.done).toBe(false)
  expect((r.value as { text: string }).text).toBe('pre-seed')
  ccDriver.cancelStream?.(first)
  await first.return(undefined) // finally 摘除 consumer（消费者清零，后续 emit 不进 pre 只进 ring/丢弃）
}

describe('R50-B-3 b) E1b execRing 迟到回放（cc 专属）', () => {
  it('执行中迟到消费者：回放 ring 最近 200 条（cap 裁剪丢最旧、保序），不回放 pre', async () => {
    const session = await ccDriver.startSession(tmpdir())
    try {
      await takePreThenLeave(session)
      ccDriver.emit?.(session, { type: 'chat_start' }) // EXEC_START：ring 清空重开 + active=true
      const total = MAX_EXEC_RING + 50
      for (let i = 0; i < total; i++) {
        ccDriver.emit?.(session, { type: 'text', text: `ev-${i}` }) // 无消费者：广播丢弃，仅入 ring
      }
      // ring 曾装 chat_start + ev-0..ev-249（251 条）→ cap 200 → 恰好 [ev-50..ev-249]
      const late = ccDriver.stream(session) as AsyncGenerator<DriverEvent>
      const got: string[] = []
      for (let i = 0; i < MAX_EXEC_RING; i++) {
        const r = await late.next()
        expect(r.done).toBe(false)
        expect(r.value.type).toBe('text') // 回放的是 ring 快照，不含 chat_start（已被裁出）
        got.push((r.value as { text: string }).text)
      }
      expect(got[0]).toBe(`ev-${total - MAX_EXEC_RING}`) // 最旧的 51 条（含 chat_start）被裁
      expect(got[MAX_EXEC_RING - 1]).toBe(`ev-${total - 1}`) // 最新照常在
      const idx = got.map((t) => Number(t.slice('ev-'.length)))
      expect([...idx].sort((a, b) => a - b)).toEqual(idx) // 保序（丢的是队头连续一段）
      await late.return(undefined)
    } finally {
      ccDriver.dispose(session)
    }
  })

  it('EXEC_START 清空重开：第二轮执行回放不含第一轮残留（含第一轮终态）', async () => {
    const session = await ccDriver.startSession(tmpdir())
    try {
      await takePreThenLeave(session)
      // 第一轮：5 过程事件 + 终态（AA-P3-3 终态先入 ring 再关 active，同步无回放窗口）
      ccDriver.emit?.(session, { type: 'chat_start' })
      for (const t of ['a1', 'a2', 'a3', 'a4', 'a5']) ccDriver.emit?.(session, { type: 'text', text: t })
      ccDriver.emit?.(session, { type: 'chat_done' })
      // 第二轮：EXEC_START 清空 ring 重开
      ccDriver.emit?.(session, { type: 'chat_start' })
      for (const t of ['b1', 'b2', 'b3']) ccDriver.emit?.(session, { type: 'text', text: t })
      const late = ccDriver.stream(session) as AsyncGenerator<DriverEvent>
      const got: DriverEvent[] = []
      for (let i = 0; i < 4; i++) {
        const r = await late.next()
        expect(r.done).toBe(false)
        got.push(r.value)
      }
      const types = got.map((e) => e.type)
      expect(types).toEqual(['chat_start', 'text', 'text', 'text']) // 只见第二轮
      expect(got.filter((e) => e.type === 'text').map((e) => (e as { text: string }).text)).toEqual(['b1', 'b2', 'b3'])
      expect(types).not.toContain('chat_done') // 第一轮终态已随 ring 清空丢弃
      await late.return(undefined)
    } finally {
      ccDriver.dispose(session)
    }
  })

  it('执行结束（execActive=false）后接入：不回放 ring——现状语义锁定（AA-P3-3 终态锚无黑盒观测面，见文件头注）', async () => {
    const session = await ccDriver.startSession(tmpdir())
    try {
      await takePreThenLeave(session)
      ccDriver.emit?.(session, { type: 'chat_start' })
      for (const t of ['x1', 'x2', 'x3']) ccDriver.emit?.(session, { type: 'text', text: t })
      ccDriver.emit?.(session, { type: 'chat_done' }) // EXEC_END：终态入 ring 后 active=false
      const late = ccDriver.stream(session) as AsyncGenerator<DriverEvent>
      const r = await Promise.race([
        late.next().then((n) => ({ kind: 'next' as const, n })),
        sleep(150).then(() => ({ kind: 'parked' as const })),
      ])
      // 执行已结束：迟到消费者不回放（SSE 侧 sync 快照兜底是既定口径）——park 零产出
      expect(r.kind).toBe('parked')
      // 悬置 next() 会挡住 return()（async generator 请求按序排队）——先 cancelStream
      // 唤醒 park 中的生成器令其自行 return（B-19 设计场景），再 return 收尾不挂
      ccDriver.cancelStream?.(late)
      await late.return(undefined)
    } finally {
      ccDriver.dispose(session)
    }
  })
})

describe('R50-B-3 c) M-1 owner 分槽 ctrl（P2-6 换新先 abort 旧；cc 专属，mock 为 noop）', () => {
  it('同 owner 换新先 abort 旧（P2-6）；同一 ctrl 重复登记幂等不自 abort；isRunning 看新在途', async () => {
    const session = await ccDriver.startSession(tmpdir())
    try {
      const old = new AbortController()
      ccDriver.registerCtrl?.(session, old, 'chat')
      expect(old.signal.aborted).toBe(false)
      const fresh = new AbortController()
      ccDriver.registerCtrl?.(session, fresh, 'chat') // 同 owner 换新：旧 ctrl 被抢占 abort
      expect(old.signal.aborted).toBe(true) // P2-6：防前者变不可中断僵尸
      expect(fresh.signal.aborted).toBe(false)
      ccDriver.registerCtrl?.(session, fresh, 'chat') // 多轮循环重复注册同一 ctrl：幂等跳过
      expect(fresh.signal.aborted).toBe(false)
      expect(ccDriver.isRunning?.(session)).toBe(true) // 新 ctrl 在途即运行中
    } finally {
      ccDriver.dispose(session)
    }
  })

  it('跨 owner（chat × self-heal）并存不互掐；unregister 终态只抹自己；interrupt 全停后 isRunning=false', async () => {
    const session = await ccDriver.startSession(tmpdir())
    try {
      const chat = new AbortController()
      const heal = new AbortController()
      ccDriver.registerCtrl?.(session, chat, 'chat')
      ccDriver.registerCtrl?.(session, heal, 'self-heal') // 跨 owner：不 abort 在途 chat
      expect(chat.signal.aborted).toBe(false)
      expect(heal.signal.aborted).toBe(false)
      expect(ccDriver.isRunning?.(session)).toBe(true)
      // chat 轮循环换新（P2-6 只作用于同槽）：旧 chat 被 abort，self-heal 槽不受波及
      const chat2 = new AbortController()
      ccDriver.registerCtrl?.(session, chat2, 'chat')
      expect(chat.signal.aborted).toBe(true)
      expect(heal.signal.aborted).toBe(false)
      // X-P2-11：chat 终态注销只抹 chat 槽——晚到注销不得抹掉别槽
      ccDriver.unregisterCtrl?.(session, chat2)
      expect(ccDriver.isRunning?.(session)).toBe(true) // self-heal 仍在途
      // interrupt = 全停（用户中断语义）：仍在槽的 ctrl 全 abort + 注销，isRunning 立即归 false
      ccDriver.interrupt?.(session)
      expect(heal.signal.aborted).toBe(true)
      expect(ccDriver.isRunning?.(session)).toBe(false)
      // chat2 已终态注销（槽空）：interrupt 不复触已收口的 ctrl——终态注销语义锁定
      expect(chat2.signal.aborted).toBe(false)
    } finally {
      ccDriver.dispose(session)
    }
  })
})
