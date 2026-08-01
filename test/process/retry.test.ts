import { test, expect } from 'vitest'
import { evaluateRetry, formatRetryState } from '../../src/process/retry.js'
import type { CheckReport } from '../../src/check/types.js'

function redReport(msg = '命中禁词'): CheckReport {
  return {
    sections: [{
      name: '禁词',
      items: [{ checkId: 'banned-word', level: 'red', message: msg }],
    }],
  }
}

function yellowReport(): CheckReport {
  return {
    sections: [{
      name: '复读',
      items: [{ checkId: 'repeat', level: 'yellow', message: '复读3处' }],
    }],
  }
}

function cleanReport(): CheckReport {
  return { sections: [] }
}

test('evaluateRetry: 无红项 → pass', () => {
  expect(evaluateRetry(cleanReport(), 0).state).toBe('pass')
  // 黄项也不打回
  expect(evaluateRetry(yellowReport(), 0).state).toBe('pass')
})

test('evaluateRetry: 红项 → retry（未超限，attempt=即将进行的第几次重写）', () => {
  const s = evaluateRetry(redReport(), 0, 3)
  expect(s.state).toBe('retry')
  if (s.state === 'retry') {
    expect(s.attempt).toBe(1)
    expect(s.maxAttempts).toBe(3)
    expect(s.redFeedback).toContain('命中禁词')
  }
})

test('evaluateRetry: 已重写 3 次仍红 → escalate（maxAttempts=3 恰好放行 3 次重写）', () => {
  // 已完成重写次数 0/1/2 均放行重写，第 3 次重写后仍红才升级
  for (const done of [0, 1, 2]) {
    const s = evaluateRetry(redReport(), done, 3)
    expect(s.state).toBe('retry')
    if (s.state === 'retry') expect(s.attempt).toBe(done + 1)
  }
  const s = evaluateRetry(redReport(), 3, 3)
  expect(s.state).toBe('escalate')
  if (s.state === 'escalate') {
    expect(s.attempt).toBe(3)
    expect(s.redFeedback).toContain('已重试 3 次')
    expect(s.redFeedback).toContain('需作者介入')
  }
})

test('formatRetryState: 三态人话', () => {
  expect(formatRetryState({ state: 'pass' })).toContain('通过')
  const retry = formatRetryState({ state: 'retry', attempt: 1, maxAttempts: 3, redFeedback: '修复x' })
  expect(retry).toContain('重写')
  const escalate = formatRetryState({ state: 'escalate', attempt: 3, redFeedback: '需作者' })
  expect(escalate).toContain('作者介入')
})
