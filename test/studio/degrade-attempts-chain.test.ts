/**
 * Z-12（五十八轮 Z 系列）回归：buildDegradeAttempts 降级链存在性锁定（degraded
 * 标记的语义前提；适配器双 attempt 行为级验证依赖 SDK 流 mock，此处锁参数面构造）。
 *
 * 来源记档（2026-09-26 测试资产行为化批）：自批号目录 y2/z-head-regressions.test.ts
 * （Z 系列杂烩）按行为拆立——本件为纯单元（零服务器）；Z-1/Z-4 →
 * rewrite-llm-call-meta、Z-9 → providers-test-bad-input。
 */
import { describe, it, expect } from 'vitest'
import { buildDegradeAttempts } from '../../src/ai/provider/adapter-errors.js'

describe('Z-12: 降级链参数面存在性', () => {
  it('structured 模式下 attempts 含首发 + 剥除面', () => {
    const plan = buildDegradeAttempts(
      { systemPrompt: 's', messages: [], structured: { name: 'x' }, tools: [{ name: 't', description: 'd', input_schema: {} }], maxTokens: 100 } as never,
      'json_schema',
      { id: 'p', model: 'm' },
      undefined,
    )
    expect(plan.attempts.length).toBeGreaterThan(1)
    expect(plan.stripStructured).not.toBeNull()
  })
})
