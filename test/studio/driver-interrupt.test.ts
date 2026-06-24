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
import type { AsyncGenerator } from 'vitest'
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

test('cc.interrupt: 推 interrupted + session 保留可再 spawn', async () => {
  const session = await ccDriver.startSession('/tmp')
  ccDriver.interrupt!(session)
  const ev = await firstEvent(ccDriver.stream(session) as AsyncGenerator<DriverEvent>)
  expect(ev.type).toBe('interrupted')
  expect(session.closed).toBe(false) // session 未关，可再 spawnRole
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
