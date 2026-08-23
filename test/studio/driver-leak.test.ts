/**
 * 低级项（第六轮）回归：driver 层 Map 残留——dispose 后迟到的 emit / interrupt /
 * stream 原先经 channel(id) 懒建复活已删除的条目（无人再清）。现对已删 channel
 * 短路，活跃条目数保持 0。
 */
import { test, expect } from 'vitest'
import { ccDriver, debugChannelCount } from '../../src/driver/cc.js'
import { mockDriver, debugCounts } from '../../src/driver/mock.js'
import { ensureSession, forgetSession } from '../../src/driver/index.js'

// Q-2（第十五轮）：ensureSession 并发首建竞态——两调用方都在对方 set 前 miss，各自
// startSession 后 set 互相覆盖：被覆盖 session 的 channel 永久无人 dispose（泄漏），
// 且两调用方拿到不同 session（/interrupt 与 ctrl 登记分裂）。微任务 FIFO 保证
// 「先 resolve 者先入表」确定成立，本用例确定性复现该时序。
test('Q-2: ensureSession 并发首建——同一 book 两调用方拿到同一 session，输家 channel 即刻回收', async () => {
  const bookId = 'q2-race-book'
  const before = debugChannelCount()
  try {
    // 不 await 第一个：两次调用都在 map 为空时进入 await startSession（复现双 miss）
    const pA = ensureSession(bookId, '/tmp')
    const pB = ensureSession(bookId, '/tmp')
    const [a, b] = await Promise.all([pA, pB])

    // 修复前：a !== b（后 set 覆盖先 set），先建 channel 永久泄漏
    expect(a).toBe(b)
    expect(debugChannelCount()).toBe(before + 1) // 输家新建的 session 已 dispose，不残留

    // 后续调用复用同一 session
    const c = await ensureSession(bookId, '/tmp')
    expect(c).toBe(a)
  } finally {
    forgetSession(bookId)
  }
  expect(debugChannelCount()).toBe(before)
})

test('cc driver：dispose 后迟到 emit / interrupt / stream 不复活 channel 条目', async () => {
  const before = debugChannelCount()
  const session = await ccDriver.startSession('/tmp')
  expect(debugChannelCount()).toBe(before + 1)

  ccDriver.dispose(session)
  expect(debugChannelCount()).toBe(before)

  // 迟到 emit / interrupt：原先 channel(id) 懒建复活条目（接口可选方法，两 driver 均已实现）
  ccDriver.emit?.(session, { type: 'interrupted', reason: 'late' })
  ccDriver.interrupt?.(session)
  expect(debugChannelCount()).toBe(before)

  // 迟到 stream：closed 会话直接返回，不再建 channel
  for await (const _ev of ccDriver.stream(session)) {
    // 不应产出任何事件
    expect.unreachable('已 dispose 会话不应产出事件')
  }
  expect(debugChannelCount()).toBe(before)
})

test('mock driver：dispose 后迟到 emit 不复活 channel / session 条目', async () => {
  const before = debugCounts()
  const session = await mockDriver.startSession('/tmp')
  expect(debugCounts().channels).toBe(before.channels + 1)
  expect(debugCounts().sessions).toBe(before.sessions + 1)

  mockDriver.dispose(session)
  expect(debugCounts()).toEqual(before)

  mockDriver.emit?.(session, { type: 'interrupted', reason: 'late' })
  expect(debugCounts()).toEqual(before)

  // 二次 dispose 幂等
  mockDriver.dispose(session)
  expect(debugCounts()).toEqual(before)
})
