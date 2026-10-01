/**
 * driver interrupt/emit 单测（#6.8③④）。
 *
 * cc.interrupt：kill 子进程 + 推 interrupted，session 保留可再 spawn。
 * cc.emit：往 session 事件流推自定义事件（review 逐角进度回流）。
 *
 * 不涉真 claude spawn：startSession 只建 channel，emit/interrupt 操作 channel 事件，
 * stream 消费验证。interrupt 无子进程时不崩、推 interrupted。
 */
import { test, expect } from 'vitest'
import { ccDriver } from '../../src/driver/cc.js'
import type { DriverEvent } from '../../src/driver/types.js'

async function firstEvent(gen: AsyncGenerator<DriverEvent>): Promise<DriverEvent> {
  const r = await gen.next()
  if (r.done) throw new Error('stream 未产出事件')
  return r.value
}

test('cc.emit: 往 session 事件流推自定义事件（review 逐角进度）', async () => {
  const session = await ccDriver.startSession('/tmp')
  ccDriver.emit!(session, { type: 'review-progress', lens: 'reader', label: '读者', phase: 'done' })
  const ev = await firstEvent(ccDriver.stream(session) as AsyncGenerator<DriverEvent>)
  expect(ev.type).toBe('review-progress')
  ccDriver.dispose(session)
})

test('cc.interrupt: 推 interrupted + session 保留可用', async () => {
  const session = await ccDriver.startSession('/tmp')
  ccDriver.interrupt!(session)
  const ev = await firstEvent(ccDriver.stream(session) as AsyncGenerator<DriverEvent>)
  expect(ev.type).toBe('interrupted')
  expect(session.closed).toBe(false) // session 未关，可再 emit / 复用流
  ccDriver.dispose(session)
})

test('cc.emit 多事件按序消费', async () => {
  const session = await ccDriver.startSession('/tmp')
  ccDriver.emit!(session, { type: 'review-progress', lens: 'reader', label: '读者', phase: 'start' })
  ccDriver.emit!(session, { type: 'review-progress', lens: 'editor', label: '编辑', phase: 'done' })
  const gen = ccDriver.stream(session) as AsyncGenerator<DriverEvent>
  const e1 = await firstEvent(gen)
  const e2 = await gen.next()
  expect(e1.type).toBe('review-progress')
  expect((e1 as { lens: string }).lens).toBe('reader')
  expect((e2.value as { lens: string }).lens).toBe('editor')
  ccDriver.dispose(session)
})

test('P1-2 registerCtrl: interrupt 可真 abort 生成请求 + isRunning 判在途', async () => {
  const session = await ccDriver.startSession('/tmp')
  const ctrl = new AbortController()
  ccDriver.registerCtrl!(session, ctrl)
  // 登记后：isRunning 判在途（SSE 新连接 sync 快照依据）
  expect(ccDriver.isRunning!(session)).toBe(true)
  // 请求未中断前 signal 存活
  expect(ctrl.signal.aborted).toBe(false)
  // interrupt → 真实 abort ctrl（生成循环据此停止拉流）
  ccDriver.interrupt!(session)
  expect(ctrl.signal.aborted).toBe(true)
  // interrupt 即注销 ctrl：isRunning 立即归 false（SSE sync 快照不假报「生成中」）
  expect(ccDriver.isRunning!(session)).toBe(false)
  const ev = await firstEvent(ccDriver.stream(session) as AsyncGenerator<DriverEvent>)
  expect(ev.type).toBe('interrupted')
  ccDriver.dispose(session)
})

test('P1-2 dispose: session 关闭时 abort 已登记 ctrl', async () => {
  const session = await ccDriver.startSession('/tmp')
  const ctrl = new AbortController()
  ccDriver.registerCtrl!(session, ctrl)
  ccDriver.dispose(session)
  expect(ctrl.signal.aborted).toBe(true)
  expect(ccDriver.isRunning!(session)).toBe(false)
})

test('P2-6 回归: 同一 ctrl 重复登记幂等，不 abort 自己（chat 多轮循环每轮注册）', async () => {
  const session = await ccDriver.startSession('/tmp')
  const ctrl = new AbortController()
  // 第一轮登记
  ccDriver.registerCtrl!(session, ctrl)
  expect(ctrl.signal.aborted).toBe(false)
  // 第二轮（模拟 chat 下一轮循环）——同引用，不得自 abort
  ccDriver.registerCtrl!(session, ctrl)
  expect(ctrl.signal.aborted).toBe(false)
  expect(ccDriver.isRunning!(session)).toBe(true)
  // 换新 ctrl 时旧的才被 abort（P2-6 原意图仍保留）
  const ctrl2 = new AbortController()
  ccDriver.registerCtrl!(session, ctrl2)
  expect(ctrl.signal.aborted).toBe(true)
  expect(ctrl2.signal.aborted).toBe(false)
  ccDriver.dispose(session)
})

// ── X-P2-11：生成终态注销（isRunning 不再假报「生成中」） ────────────────

test('X-P2-11 unregisterCtrl: 终态注销后 isRunning 归 false（done 后 SSE 快照不假报在途）', async () => {
  const session = await ccDriver.startSession('/tmp')
  const ctrl = new AbortController()
  ccDriver.registerCtrl!(session, ctrl)
  expect(ccDriver.isRunning!(session)).toBe(true)
  // 生成正常完成（done/error）→ 编排层注销
  ccDriver.unregisterCtrl!(session, ctrl)
  expect(ccDriver.isRunning!(session)).toBe(false)
  // session 仍可用（可再登记新 ctrl）
  ccDriver.registerCtrl!(session, ctrl)
  expect(ccDriver.isRunning!(session)).toBe(true)
  ccDriver.dispose(session)
})

test('X-P2-11 unregisterCtrl: 只注销自己——晚到的旧注销不抹掉新登记', async () => {
  const session = await ccDriver.startSession('/tmp')
  const ctrl1 = new AbortController()
  const ctrl2 = new AbortController()
  ccDriver.registerCtrl!(session, ctrl1)
  ccDriver.registerCtrl!(session, ctrl2) // ctrl1 被 abort（P2-6），ctrl2 在途
  // ctrl1 的晚到 unregister（异步竞态）不得影响 ctrl2
  ccDriver.unregisterCtrl!(session, ctrl1)
  expect(ccDriver.isRunning!(session)).toBe(true)
  ccDriver.unregisterCtrl!(session, ctrl2)
  expect(ccDriver.isRunning!(session)).toBe(false)
  ccDriver.dispose(session)
})

test('X-P2-11 isRunning 兜底: 已 abort 的 ctrl 不算在途（编排层直接 abort 自身的路径）', async () => {
  const session = await ccDriver.startSession('/tmp')
  const ctrl = new AbortController()
  ccDriver.registerCtrl!(session, ctrl)
  ctrl.abort() // 不经 driver.interrupt，编排层自行 abort（如超时）
  expect(ccDriver.isRunning!(session)).toBe(false)
  ccDriver.dispose(session)
})

test('Bug A 回归: cc 多消费者广播——前端 + 调试 curl 双 SSE 连接都收到全部事件', async () => {
  const session = await ccDriver.startSession('/tmp')

  // 两个并发消费者
  const done1 = new Promise<DriverEvent[]>((resolve) => {
    const out: DriverEvent[] = []
    void (async () => {
      for await (const ev of ccDriver.stream(session)) {
        out.push(ev)
        if (ev.type === 'done') resolve(out)
      }
    })()
  })
  const done2 = new Promise<DriverEvent[]>((resolve) => {
    const out: DriverEvent[] = []
    void (async () => {
      for await (const ev of ccDriver.stream(session)) {
        out.push(ev)
        if (ev.type === 'done') resolve(out)
      }
    })()
  })

  // emit 一串事件（模拟 self-heal 闭环）
  ccDriver.emit!(session, { type: 'self_heal_phase', phase: 'drafting', attempt: 1 })
  ccDriver.emit!(session, { type: 'self_heal_phase', phase: 'checking', attempt: 0 })
  ccDriver.emit!(session, { type: 'done', cost: 0, usage: 0, reason: 'success' })

  const [e1, e2] = await Promise.all([done1, done2])
  ccDriver.dispose(session)

  // 两个消费者都收到完整序列
  const types1 = e1.map((e) => e.type)
  const types2 = e2.map((e) => e.type)
  expect(types1).toEqual(['self_heal_phase', 'self_heal_phase', 'done'])
  expect(types2).toEqual(['self_heal_phase', 'self_heal_phase', 'done'])
})
