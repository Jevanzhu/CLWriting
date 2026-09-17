/**
 * R50-B-3（五十轮）：cc driver 精密行为回归网。
 *
 * 清单三条中 a) 队列 cap 溢出丢最旧 + notice 一次性（R73-9「容量+1 内部槽」）经核对
 * 已由 cc-cancel-stream.test.ts 的「M-P2-1 已连接消费者队列上限」describe 精确覆盖
 * （含 R73-9 maxQueue+1 断言、ev-0 丢弃、notice 恰 1 条、「拉空复位后第二轮重新补发」
 * 两个用例）——本轮不重复建设，如实报告。
 *
 * 本文件补：
 * - b) E1b execRing 迟到回放（execRing 分桶批 2026-09-17 后按腿）：执行中迟到的
 *   消费者（pre 已被接管）回放本腿最近 MAX_EXEC_RING(200) 条协议单元（cap 裁剪 +
 *   保序）；本腿 EXEC_START 清空重开；本腿结束（active=false）后接入不回放；跨腿
 *   （chat 内嵌写章）不再互相清环/熄灭——写手腿终态后 chat 腿仍回放（分桶批拍板
 *   语义，翻转本文件旧「单环现状锁定」口径）。AA-P3-3 的「终态先入 ring」在回放
 *   条件（本腿 active 才回放）下无黑盒观测面：终态 emit 同步置 false，此后接入的
 *   消费者走不到本腿 ring 回放分支，终态锚行为以源码注释为准（防未来回放面扩展时
 *   误删终态入 ring 逻辑，见 cc.ts AA-P3-3 注）。
 * - c) M-1 owner 分槽 ctrl：P2-6 同 owner 换新先 abort 旧 / 同一 ctrl 重复登记幂等 /
 *   跨 owner（chat × self-heal）并存不互掐 / X-P2-11 终态注销只抹自己 / interrupt 全停。
 *
 * mock driver 无 execRing、registerCtrl 为 noop（见 mock.ts 头注），b/c 仅测 ccDriver。
 */
import { tmpdir } from 'node:os'
import { describe, it, expect } from 'vitest'
import { ccDriver, MAX_EXEC_RING } from '../../src/driver/cc.js'
import type { DriverEvent } from '../../src/driver/types.js'
import { sleep } from '../helpers/wait-for.js'

/** 推一个接管 pre 的消费者（拿走首事件后断开）——置 preTaken=true，使后续迟到
 *  消费者走 execRing 回放分支（模拟「首个消费者早已来过又走」的重连形态）
 *  R-P1-1：pre 种子是 text 且无前导锚 → 接管序列 = 合成 text_reset + 暂存事件 */
async function takePreThenLeave(session: Awaited<ReturnType<typeof ccDriver.startSession>>): Promise<void> {
  ccDriver.emit?.(session, { type: 'text', text: 'pre-seed' }) // 无消费者：进 pre（execActive=false 不入 ring）
  const first = ccDriver.stream(session) as AsyncGenerator<DriverEvent>
  const r = await first.next() // 启动生成器：注册 consumer + 接管 pre（preTaken=true）
  expect(r.done).toBe(false)
  expect(r.value.type).toBe('text_reset') // R-P1-1：回放前导清屏锚
  const r2 = await first.next()
  expect((r2.value as { text: string }).text).toBe('pre-seed')
  ccDriver.cancelStream?.(first)
  await first.return(undefined) // finally 摘除 consumer（消费者清零，后续 emit 不进 pre 只进 ring/丢弃）
}

describe('R50-B-3 b) E1b execRing 迟到回放（cc 专属）', () => {
  it('执行中迟到消费者：回放本腿 ring 最近 200 条（cap 裁剪丢最旧、保序），不回放 pre', async () => {
    const session = await ccDriver.startSession(tmpdir())
    try {
      await takePreThenLeave(session)
      // 写手腿 EXEC_START：本腿 ring 清空重开 + active=true（分桶批 2026-09-17：
      // chat_start 归 chat 腿、text 归写手腿——cap 语义按腿各测，本用例钉写手腿）
      ccDriver.emit?.(session, { type: 'role_spawn', role: 'writer', parentToolUseId: 'tu-1' })
      const total = MAX_EXEC_RING + 50
      for (let i = 0; i < total; i++) {
        ccDriver.emit?.(session, { type: 'text', text: `ev-${i}` }) // 无消费者：广播丢弃，仅入写手腿 ring
      }
      // 写手腿 ring 曾装 role_spawn + ev-0..ev-249（251 条）→ cap 200 → 恰好 [ev-50..ev-249]
      const late = ccDriver.stream(session) as AsyncGenerator<DriverEvent>
      // R-P1-1：回放（裁剪后）以 text 起头且无锚 → 前导合成 text_reset
      const head = await late.next()
      expect(head.value.type).toBe('text_reset')
      const got: string[] = []
      for (let i = 0; i < MAX_EXEC_RING; i++) {
        const r = await late.next()
        expect(r.done).toBe(false)
        expect(r.value.type).toBe('text') // 回放的是本腿 ring 快照，不含 role_spawn（已被裁出）
        got.push((r.value as { text: string }).text)
      }
      expect(got[0]).toBe(`ev-${total - MAX_EXEC_RING}`) // 最旧的 51 条（含 role_spawn）被裁
      expect(got[MAX_EXEC_RING - 1]).toBe(`ev-${total - 1}`) // 最新照常在
      const idx = got.map((t) => Number(t.slice('ev-'.length)))
      expect([...idx].sort((a, b) => a - b)).toEqual(idx) // 保序（丢的是队头连续一段）
      await late.return(undefined)
    } finally {
      ccDriver.dispose(session)
    }
  })

  it('本腿 EXEC_START 清空重开：第二轮执行回放不含第一轮残留（含第一轮终态）', async () => {
    const session = await ccDriver.startSession(tmpdir())
    try {
      await takePreThenLeave(session)
      // 第一轮（写手腿）：5 过程事件 + 终态（AA-P3-3 终态先入 ring 再关 active，同步无回放窗口）
      ccDriver.emit?.(session, { type: 'role_spawn', role: 'writer', parentToolUseId: 'tu-1' })
      for (const t of ['a1', 'a2', 'a3', 'a4', 'a5']) ccDriver.emit?.(session, { type: 'text', text: t })
      ccDriver.emit?.(session, { type: 'done', usage: 0, reason: 'success' })
      // 第二轮：本腿 EXEC_START 清空 ring 重开
      ccDriver.emit?.(session, { type: 'role_spawn', role: 'writer', parentToolUseId: 'tu-2' })
      for (const t of ['b1', 'b2', 'b3']) ccDriver.emit?.(session, { type: 'text', text: t })
      const late = ccDriver.stream(session) as AsyncGenerator<DriverEvent>
      const got: DriverEvent[] = []
      for (let i = 0; i < 4; i++) {
        const r = await late.next()
        expect(r.done).toBe(false)
        got.push(r.value)
      }
      // role_spawn 本身是 workbench 清屏锚 → 无需合成 text_reset，其后只见第二轮
      const types = got.map((e) => e.type)
      expect(types).toEqual(['role_spawn', 'text', 'text', 'text'])
      expect(got.filter((e) => e.type === 'text').map((e) => (e as { text: string }).text)).toEqual(['b1', 'b2', 'b3'])
      expect(types).not.toContain('done') // 第一轮终态已随本腿 ring 清空丢弃
      await late.return(undefined)
    } finally {
      ccDriver.dispose(session)
    }
  })

  it('本腿执行结束（active=false）后接入：不回放本腿 ring——语义锁定（AA-P3-3 终态锚无黑盒观测面，见文件头注）', async () => {
    const session = await ccDriver.startSession(tmpdir())
    try {
      await takePreThenLeave(session)
      ccDriver.emit?.(session, { type: 'chat_start' })
      for (const t of ['x1', 'x2', 'x3']) ccDriver.emit?.(session, { type: 'chat_text', text: t })
      ccDriver.emit?.(session, { type: 'chat_done' }) // EXEC_END：终态入本腿 ring 后 active=false
      const late = ccDriver.stream(session) as AsyncGenerator<DriverEvent>
      const r = await Promise.race([
        late.next().then((n) => ({ kind: 'next' as const, n })),
        sleep(150).then(() => ({ kind: 'parked' as const })),
      ])
      // 本腿执行已结束：迟到消费者不回放（SSE 侧 sync 快照兜底是既定口径）——park 零产出
      expect(r.kind).toBe('parked')
      // 悬置 next() 会挡住 return()（async generator 请求按序排队）——先 cancelStream
      // 唤醒 park 中的生成器令其自行 return（B-19 设计场景），再 return 收尾不挂
      ccDriver.cancelStream?.(late)
      await late.return(undefined)
    } finally {
      ccDriver.dispose(session)
    }
  })

  it('跨腿（execRing 分桶批 2026-09-17）：写手腿终态不灭 chat 腿——chat 仍活跃时迟到消费者回放 chat 段', async () => {
    const session = await ccDriver.startSession(tmpdir())
    try {
      await takePreThenLeave(session)
      // chat 内嵌 write_chapter 形态：外层 chat 活跃期间写手腿开跑并先行结束。
      // 分桶前单环形态此景 = role_spawn 清环 + done 熄灭 execActive → 迟到者零回放（丢段）；
      // 分桶后 = chat 段照常回放（写手段按「本腿结束不回放」锁定语义不入回放——上例同文件）
      ccDriver.emit?.(session, { type: 'chat_start' })
      ccDriver.emit?.(session, { type: 'chat_text', text: '问' })
      ccDriver.emit?.(session, { type: 'role_spawn', role: 'writer', parentToolUseId: 'self-heal' })
      ccDriver.emit?.(session, { type: 'text', text: '章内容' })
      ccDriver.emit?.(session, { type: 'done', usage: 0, reason: 'success' }) // 写手腿 EXEC_END：只关写手腿
      const late = ccDriver.stream(session) as AsyncGenerator<DriverEvent>
      const got: DriverEvent[] = []
      for (let i = 0; i < 3; i++) {
        const r = await late.next()
        expect(r.done).toBe(false)
        got.push(r.value)
      }
      // 0918独立重评修复批（E001）：chat 腿活跃回放最前补 chat_replay_begin 锚
      expect(got.map((e) => e.type)).toEqual(['chat_replay_begin', 'chat_start', 'chat_text'])
      // chat_* 与新锚均非 text 也非清屏锚 → 无需合成 text_reset
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
