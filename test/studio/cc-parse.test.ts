/**
 * cc parseLine 测试(横切 P0):验证 stream-json 行 → DriverEvent 解析。
 *
 * parseLine 是 cc driver 的解析核心(claude CLI stream-json → 事件),易回归。
 * 不调 claude(纯函数,给 JSON 行验输出)。
 */
import { describe, it, expect } from 'vitest'
import { parseLine } from '../../src/driver/cc.js'

describe('cc parseLine(stream-json → DriverEvent)', () => {
  it('system init → init 事件(sessionId/agents/tools)', () => {
    const line = JSON.stringify({
      type: 'system',
      subtype: 'init',
      session_id: 's1',
      agents: ['writer', 'reader-review'],
      tools: ['Read', 'Edit'],
    })
    expect(parseLine(line, undefined)).toEqual([
      { type: 'init', sessionId: 's1', agents: ['writer', 'reader-review'], tools: ['Read', 'Edit'] },
    ])
  })

  it('assistant text → text 事件(带 role)', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'text', text: '你好' }] },
    })
    expect(parseLine(line, 'writer')).toEqual([{ type: 'text', text: '你好', role: 'writer' }])
  })

  it('assistant tool_use → tool_use 事件', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', name: 'Read', input: { path: '/x' } }] },
    })
    const ev = parseLine(line, 'writer')
    expect(ev[0]?.type).toBe('tool_use')
    expect((ev[0] as { tool: string }).tool).toBe('Read')
  })

  it('user tool_result → tool_result 事件', () => {
    const line = JSON.stringify({
      type: 'user',
      message: { content: [{ type: 'tool_result', content: '结果文本' }] },
    })
    expect(parseLine(line, undefined)[0]?.type).toBe('tool_result')
  })

  it('result success → done(reason success + cost/usage)', () => {
    const line = JSON.stringify({
      type: 'result',
      subtype: 'success',
      total_cost_usd: 0.01,
      usage: { output_tokens: 500 },
    })
    expect(parseLine(line, undefined)).toEqual([{ type: 'done', cost: 0.01, usage: 500, reason: 'success' }])
  })

  it('result error(is_error) → done(reason error)', () => {
    const line = JSON.stringify({ type: 'result', is_error: true, total_cost_usd: 0, usage: { output_tokens: 0 } })
    expect((parseLine(line, undefined)[0] as { reason: string }).reason).toBe('error')
  })

  it('result 无 subtype/is_error → done(reason cancelled)', () => {
    const line = JSON.stringify({ type: 'result', total_cost_usd: 0, usage: { output_tokens: 0 } })
    expect((parseLine(line, undefined)[0] as { reason: string }).reason).toBe('cancelled')
  })

  it('非 JSON 行 → [](容错)', () => {
    expect(parseLine('not json at all', undefined)).toEqual([])
  })

  it('未知类型 → [](容错)', () => {
    expect(parseLine(JSON.stringify({ type: 'unknown' }), undefined)).toEqual([])
  })
})
