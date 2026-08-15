/**
 * F1-P2 chain-bridge 单测：链路事件构造器载荷 + task→layer 五层映射 + ChainRecorder 写失败静默。
 */
import { describe, expect, it } from 'vitest'
import {
  stepStartEvent,
  stepEndEvent,
  llmCallEvent,
  llmRetryEvent,
  retryAttemptEvent,
  checkReportEvent,
  layerForTask,
  ChainRecorder,
} from '../../src/events/chain-bridge.js'

describe('F1-P2 链路事件构造器', () => {
  it('step/start + step/end 载荷（task + layer + reason）', () => {
    expect(stepStartEvent('chat', 'chat')).toEqual({ type: 'step/start', data: { task: 'chat', layer: 'chat' } })
    expect(stepEndEvent('self-heal', 'self-heal', 'error')).toEqual({
      type: 'step/end',
      data: { task: 'self-heal', layer: 'self-heal', reason: 'error' },
    })
  })

  it('llm/call 载荷透传 usage/errCode/promptMeta（可选字段不落 undefined）', () => {
    const ev = llmCallEvent({
      runId: 'r1',
      task: 'draft',
      tierKind: 'creative',
      model: 'm',
      attempt: 0,
      stopReason: 'end_turn',
      usage: { input: 10, output: 5 },
      durationMs: 100,
      ok: true,
    })
    expect(ev.type).toBe('llm/call')
    expect(ev.data).toMatchObject({ runId: 'r1', task: 'draft', ok: true, usage: { input: 10, output: 5 } })
    expect('errCode' in ev.data).toBe(false)
    expect('promptMeta' in ev.data).toBe(false)
  })

  it('llm/retry + retry/attempt + check/report 载荷', () => {
    expect(llmRetryEvent({ attempt: 1, delayMs: 500, errCode: 'RATE_LIMIT' })).toEqual({
      type: 'llm/retry',
      data: { attempt: 1, delayMs: 500, errCode: 'RATE_LIMIT' },
    })
    expect(retryAttemptEvent({ attempt: 2, maxAttempts: 3, redIssues: ['a'] })).toEqual({
      type: 'retry/attempt',
      data: { attempt: 2, maxAttempts: 3, redIssues: ['a'] },
    })
    expect(checkReportEvent({ chapter: 5, reds: ['x'], yellows: ['y'] })).toEqual({
      type: 'check/report',
      data: { chapter: 5, reds: ['x'], yellows: ['y'] },
    })
  })
})

describe('F1-P2 layerForTask 五层映射', () => {
  it('五层：chat/draft/review/self-heal/context', () => {
    expect(layerForTask('chat')).toBe('chat')
    expect(layerForTask('spawn-write')).toBe('draft')
    expect(layerForTask('rewrite')).toBe('draft')
    expect(layerForTask('review')).toBe('review')
    expect(layerForTask('analysis')).toBe('review')
    expect(layerForTask('self-heal')).toBe('self-heal')
    expect(layerForTask('outline')).toBe('context')
    expect(layerForTask('onboard')).toBe('context')
    expect(layerForTask('unknown-task')).toBe('context')
  })
})

describe('F1-P2 ChainRecorder', () => {
  it('store/session 缺失时 add 静默跳过（观测层不炸）', () => {
    const r = new ChainRecorder(null, null)
    expect(() => r.add(stepStartEvent('chat', 'chat'))).not.toThrow()
    expect(() => r.close()).not.toThrow()
  })

  it('写事件到真 store（workspace 会话）且失败静默', () => {
    // 用真实 store 验证 add 生效（集成点在 chain-events.test.ts，这里验证错误路径静默）
    // 构造一个 appendEvent 抛错的假 store：add 不应抛
    const badStore = {
      appendEvent: () => { throw new Error('disk full') },
      close: () => { throw new Error('close fail') },
    } as never;
    const r = new ChainRecorder(badStore, 'ws-x')
    expect(() => r.add(llmCallEvent({ runId: 'r', task: 't', tierKind: 'creative', model: 'm', attempt: 0, stopReason: 'end_turn', durationMs: 1, ok: true }))).not.toThrow()
    expect(() => r.close()).not.toThrow()
  })
})

