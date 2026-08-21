/**
 * 低级项（第六轮）回归：driver 层 Map 残留——dispose 后迟到的 emit / interrupt /
 * stream 原先经 channel(id) 懒建复活已删除的条目（无人再清）。现对已删 channel
 * 短路，活跃条目数保持 0。
 */
import { test, expect } from 'vitest'
import { ccDriver, debugChannelCount } from '../../src/driver/cc.js'
import { mockDriver, debugCounts } from '../../src/driver/mock.js'

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
