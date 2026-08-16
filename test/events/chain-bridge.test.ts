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
  revisionRefEvent,
  settingsSnapshotEvent,
  foreshadowChangeEvent,
  authorSignalEvent,
  ruleHitEvent,
  layerForTask,
  ChainRecorder,
} from '../../src/events/chain-bridge.js'
import { assistantMessageEvent } from '../../src/events/chat-bridge.js'

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
    expect(() => r.flush()).not.toThrow()
    expect(() => r.close()).not.toThrow()
  })

  it('写事件到真 store（workspace 会话）且失败静默', () => {
    // 用真实 store 验证 add 生效（集成点在 chain-events.test.ts，这里验证错误路径静默）
    // 构造一个 appendEvents 抛错的假 store：add/flush/close 不应抛
    const badStore = {
      appendEvents: () => { throw new Error('disk full') },
      close: () => { throw new Error('close fail') },
    } as never;
    const r = new ChainRecorder(badStore, 'ws-x')
    expect(() => r.add(llmCallEvent({ runId: 'r', task: 't', tierKind: 'creative', model: 'm', attempt: 0, stopReason: 'end_turn', durationMs: 1, ok: true }))).not.toThrow()
    expect(() => r.close()).not.toThrow()
  })

  /** 记录 appendEvents 调用（次数 + 每批事件）的假 store——批事务口径断言用。 */
  function recordingStore() {
    const calls: { sessionId: string; events: unknown[] }[] = []
    return {
      calls,
      store: {
        appendEvents: (sessionId: string, events: unknown[]) => {
          calls.push({ sessionId, events })
          return events.map((_, i) => i + 1)
        },
        close: () => {},
      } as never,
    }
  }

  it('Z-P2-7 批事务：add 只缓冲，close 一次 appendEvents 落整批（不再每事件一事务）', () => {
    const { calls, store } = recordingStore()
    const r = new ChainRecorder(store, 'ws-x')
    r.add(stepStartEvent('chat', 'chat'))
    r.add(llmCallEvent({ runId: 'r', task: 'chat', tierKind: 'creative', model: 'm', attempt: 0, stopReason: 'end_turn', durationMs: 1, ok: true }))
    r.add(stepEndEvent('chat', 'chat', 'completed'))
    expect(calls).toHaveLength(0) // 未 flush 前零事务
    r.close()
    expect(calls).toHaveLength(1) // 整批一个事务
    expect(calls[0]!.sessionId).toBe('ws-x')
    expect((calls[0]!.events as { type: string }[]).map((e) => e.type)).toEqual(['step/start', 'llm/call', 'step/end'])
  })

  it('Z-P2-7 flush：显式持久化点（退避等待前），缓冲清空后 close 不再空事务', () => {
    const { calls, store } = recordingStore()
    const r = new ChainRecorder(store, 'ws-x')
    r.add(llmRetryEvent({ attempt: 1, delayMs: 500 }))
    r.flush()
    expect(calls).toHaveLength(1)
    r.add(stepEndEvent('chat', 'chat', 'completed'))
    r.close()
    expect(calls).toHaveLength(2) // close 只落剩余缓冲
    expect((calls[1]!.events as { type: string }[]).map((e) => e.type)).toEqual(['step/end'])
  })

  it('Z-P2-7 缓冲超阈值自动凑批落库', () => {
    const { calls, store } = recordingStore()
    const r = new ChainRecorder(store, 'ws-x')
    for (let i = 0; i < 40; i++) r.add(llmRetryEvent({ attempt: i, delayMs: 1 }))
    // 40 条 > 阈值 32 → 至少一次自动 flush；close 落尾批
    r.close()
    const total = calls.reduce((n, c) => n + c.events.length, 0)
    expect(total).toBe(40)
    expect(calls.length).toBeLessThan(40) // 远少于每事件一事务
    for (const c of calls) expect(c.events.length).toBeLessThanOrEqual(32)
  })
})

describe('F1-P3 血缘事件构造器', () => {
  it('revision/ref + settings/snapshot 载荷', () => {
    expect(revisionRefEvent({ chapter: 3, revision: 'r9', path: '写作/正文/3.md' })).toEqual({
      type: 'revision/ref',
      data: { chapter: 3, revision: 'r9', path: '写作/正文/3.md' },
    })
    expect(settingsSnapshotEvent({ scope: 'settings', digest: 'd1' })).toEqual({
      type: 'settings/snapshot',
      data: { scope: 'settings', digest: 'd1' },
    })
    expect(settingsSnapshotEvent({ scope: 'chapter', version: 'v2', digest: 'd2' })).toEqual({
      type: 'settings/snapshot',
      data: { scope: 'chapter', version: 'v2', digest: 'd2' },
    })
  })

  it('foreshadow/change + author/signal + rule/hit 载荷', () => {
    expect(foreshadowChangeEvent({ operation: 'complete', title: '古剑' })).toEqual({
      type: 'foreshadow/change',
      data: { operation: 'complete', title: '古剑' },
    })
    expect(authorSignalEvent({ ruleId: 'ai-cliche', message: '删掉', task: 'self-heal' })).toEqual({
      type: 'author/signal',
      data: { ruleId: 'ai-cliche', message: '删掉', task: 'self-heal' },
    })
    expect(ruleHitEvent({ ruleId: 'banned-word', task: 'check', message: '命中' })).toEqual({
      type: 'rule/hit',
      data: { ruleId: 'banned-word', task: 'check', message: '命中' },
    })
  })

  it('assistantMessageEvent 可选 sourceSeqs 透传', () => {
    expect(assistantMessageEvent('ok', undefined, undefined, [3, 4])).toEqual({
      type: 'assistant/message',
      data: { message: 'ok' },
      surfaceOp: 'append',
      sourceSeqs: [3, 4],
    })
    expect(assistantMessageEvent('ok')).not.toHaveProperty('sourceSeqs')
  })
})

