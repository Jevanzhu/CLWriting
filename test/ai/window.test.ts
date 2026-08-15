/**
 * A1（CS-12）：窗口参数归一——非法值归 null（不设限），绝不猜数字。
 * 测试写法照抄 cherry：非法值批量断言不 throw 且返回 null。
 */
import { test, expect } from 'vitest'
import { normalizeMaxMessages } from '../../src/ai/prompts/window.js'
import { trimHistory } from '../../src/ai/prompts/chat.js'
import type { ChatMsg } from '../../src/ai/provider/types.js'

test('normalizeMaxMessages: 非法值批量 → null（不 throw、不猜数字）', () => {
  for (const bad of [0, -3, NaN, Infinity, -Infinity, '2', {}, null, undefined, 2.5, 1e400]) {
    expect(normalizeMaxMessages(bad)).toBeNull()
  }
})

test('normalizeMaxMessages: 合法正整数原样返回', () => {
  for (const ok of [1, 10, 1000, Number.MAX_SAFE_INTEGER]) {
    expect(normalizeMaxMessages(ok)).toBe(ok)
  }
})

test('trimHistory 接线：非法 maxTurns → 原引用返回（不设限）', () => {
  const history: ChatMsg[] = []
  for (let i = 0; i < 60; i++) history.push({ role: i % 2 === 0 ? 'user' : 'assistant', content: `m${i}` })
  for (const bad of [0, -1, NaN, 2.5] as const) {
    expect(trimHistory(history, bad)).toBe(history)
  }
  // 合法值照常截断（落在 user 上）
  const trimmed = trimHistory(history, 3)
  expect(trimmed).not.toBe(history)
  expect(trimmed.length).toBeLessThan(history.length)
  expect(trimmed[0]!.role).toBe('user')
})
