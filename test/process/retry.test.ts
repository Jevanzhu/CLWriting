import { test, expect } from 'vitest'
import { evaluateRetry, redSetKey, buildStrategyReminder } from '../../src/process/retry.js'
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

// O-8（第十三轮）：formatRetryState 准死代码已删（生产提示走 state 卡人话）

// ── A4（DSH-19）：红项 canonical key + 换策略提醒 ──

test('redSetKey: 顺序无关 + 去重（「完全相同」的判定基础）', () => {
  expect(redSetKey(['红A', '红B'])).toBe(redSetKey(['红B', '红A']))
  expect(redSetKey(['红A', '红A', '红B'])).toBe(redSetKey(['红B', '红A']))
  expect(redSetKey(['红A'])).not.toBe(redSetKey(['红B']))
  expect(redSetKey(['红A', '红B'])).not.toBe(redSetKey(['红A']))
  expect(redSetKey([])).toBe('')
})

test('buildStrategyReminder: 提醒不拦截——列红项 + 换修法指引', () => {
  const r = buildStrategyReminder(['命中禁词：老阴比', '正文事实与账本声明不一致'])
  expect(r).toContain('策略提醒')
  expect(r).toContain('完全相同')
  expect(r).toContain('命中禁词：老阴比')
  expect(r).toContain('正文事实与账本声明不一致')
  expect(r).toContain('换')
})
