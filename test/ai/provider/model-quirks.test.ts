/**
 * model-quirks 纯函数单测（方案 §6：六家 × 五维度矩阵断言）。
 */
import { describe, expect, it } from 'vitest'
import { detectFamily, quirksFor } from '../../../src/ai/provider/model-quirks.js'

describe('detectFamily 系列判定', () => {
  it('按模型名前缀判定', () => {
    expect(detectFamily('gpt-4o')).toBe('gpt')
    expect(detectFamily('o3-mini')).toBe('gpt')
    expect(detectFamily('grok-4.6')).toBe('grok')
    expect(detectFamily('deepseek-chat')).toBe('deepseek')
    expect(detectFamily('glm-5.2')).toBe('glm')
    expect(detectFamily('kimi-k3')).toBe('kimi')
    expect(detectFamily('k3')).toBe('kimi')
    expect(detectFamily('claude-sonnet-5')).toBe('claude')
    expect(detectFamily('custom-model')).toBe('unknown')
  })
})

describe('quirksFor 五维度矩阵', () => {
  it('gpt：max_completion_tokens + effort 三档映射 + json_schema', () => {
    const q = quirksFor('gpt-5.1')
    expect(q.maxTokensKey).toBe('max_completion_tokens')
    expect(q.reasoningEffort('medium')).toBe('medium')
    expect(q.reasoningEffort('xhigh')).toBe('high')
    expect(q.thinkingWithEffort).toBe(false)
    expect(q.trimStop(['a'])).toEqual(['a'])
    expect(q.emitStreamOptions).toBe(true)
    expect(q.structuredMode).toBe('json_schema')
  })

  it('grok：stop 裁剪为 null + effort 透传 + json_schema', () => {
    const q = quirksFor('grok-4.6')
    expect(q.maxTokensKey).toBe('max_completion_tokens')
    expect(q.reasoningEffort('medium')).toBe('medium')
    expect(q.trimStop(['a', 'b'])).toBeNull()
    expect(q.emitStreamOptions).toBe(true)
    expect(q.structuredMode).toBe('json_schema')
  })

  it('deepseek：max_tokens + effort 三档收敛 + thinking 双写法 + json_object', () => {
    const q = quirksFor('deepseek-chat')
    expect(q.maxTokensKey).toBe('max_tokens')
    expect(q.reasoningEffort('medium')).toBe('high')
    expect(q.reasoningEffort('xhigh')).toBe('max')
    expect(q.reasoningEffort('low')).toBe('low')
    expect(q.thinkingWithEffort).toBe(true)
    expect(q.trimStop(['a'])).toEqual(['a'])
    expect(q.emitStreamOptions).toBe(true)
    expect(q.structuredMode).toBe('json_object')
  })

  it('glm：5.2+ 才发 effort + stop 取首个 + 不发 stream_options + json_object', () => {
    const old = quirksFor('glm-4.6')
    expect(old.reasoningEffort('high')).toBeNull()
    const q = quirksFor('glm-5.2')
    expect(q.reasoningEffort('medium')).toBe('medium')
    expect(q.reasoningEffort('xhigh')).toBe('high')
    expect(q.trimStop(['a', 'b', 'c'])).toEqual(['a'])
    expect(q.emitStreamOptions).toBe(false)
    expect(q.structuredMode).toBe('json_object')
  })

  it('kimi：k3 才发 effort（medium→high、xhigh→max）+ stop 前 5 + json_schema', () => {
    const k2 = quirksFor('k2.7-code')
    expect(k2.reasoningEffort('high')).toBeNull()
    expect(k2.maxTokensKey).toBe('max_completion_tokens')
    const q = quirksFor('kimi-k3')
    expect(q.reasoningEffort('medium')).toBe('high')
    expect(q.reasoningEffort('xhigh')).toBe('max')
    expect(q.trimStop(['a', 'b', 'c', 'd', 'e', 'f'])).toEqual(['a', 'b', 'c', 'd', 'e'])
    expect(q.emitStreamOptions).toBe(true)
    expect(q.structuredMode).toBe('json_schema')
  })

  it('claude/unknown：保守省略一切可选参数', () => {
    for (const model of ['claude-sonnet-5', 'custom-model']) {
      const q = quirksFor(model)
      expect(q.reasoningEffort('high')).toBeNull()
      expect(q.thinkingWithEffort).toBe(false)
      expect(q.maxTokensKey).toBe('max_tokens')
      expect(q.trimStop(['a', 'b'])).toEqual(['a', 'b'])
      expect(q.emitStreamOptions).toBe(true)
      expect(q.structuredMode).toBe('none')
    }
  })
})
