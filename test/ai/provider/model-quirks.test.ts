/**
 * 模型系列参数表单测（表驱动重构 §五：七系列 × 全维度断言）。
 *
 * 批次 1：验证表项数据正确性——每系列断言能力维度 + 线格式维度关键字段。
 * 现有 OpenAI 侧五维度测试保留；新增 toolUse / toolChoiceMode / effortMap /
 * maxOutputTokens / anthropicEffortWire / parallelControl / echoReasoning。
 * （2026-08-14 定稿：effortValues 死字段已删；effortMap 仅 deepseek 保留）
 */
import { describe, expect, it } from 'vitest'
import { detectFamily, quirksFor, responsesQuirksFor } from '../../../src/ai/provider/model-quirks.js'

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

// ── OpenAI 线格式五维度（现有测试保留） ──

describe('OpenAI 线格式五维度矩阵', () => {
  it('gpt：max_completion_tokens + effort 透传 + json_schema', () => {
    const q = quirksFor('gpt-5.1')
    expect(q.maxTokensKey).toBe('max_completion_tokens')
    expect(q.reasoningEffort('medium')).toBe('medium')
    expect(q.reasoningEffort('xhigh')).toBe('xhigh')
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
    // 2026-08-14 定稿：官方折叠是服务端行为，客户端全透传
    expect(q.reasoningEffort('medium')).toBe('medium')
    expect(q.reasoningEffort('xhigh')).toBe('xhigh')
    expect(q.trimStop(['a', 'b', 'c'])).toEqual(['a'])
    expect(q.emitStreamOptions).toBe(false)
    expect(q.structuredMode).toBe('json_object')
  })

  it('kimi：k3 才发 effort（全透传）+ stop 前 5 + json_schema', () => {
    const k2 = quirksFor('k2.7-code')
    expect(k2.reasoningEffort('high')).toBeNull()
    expect(k2.maxTokensKey).toBe('max_completion_tokens')
    const q = quirksFor('kimi-k3')
    expect(q.reasoningEffort('medium')).toBe('medium')
    expect(q.reasoningEffort('xhigh')).toBe('xhigh')
    expect(q.trimStop(['a', 'b', 'c', 'd', 'e', 'f'])).toEqual(['a', 'b', 'c', 'd', 'e'])
    expect(q.emitStreamOptions).toBe(true)
    expect(q.structuredMode).toBe('json_schema')
  })

  it('claude：走 anthropic 协议不发 reasoning_effort + json_schema', () => {
    const q = quirksFor('claude-sonnet-5')
    expect(q.reasoningEffort('high')).toBeNull()
    expect(q.thinkingWithEffort).toBe(false)
    expect(q.maxTokensKey).toBe('max_tokens')
    expect(q.trimStop(['a', 'b'])).toEqual(['a', 'b'])
    expect(q.emitStreamOptions).toBe(true)
    expect(q.structuredMode).toBe('json_schema')
  })

  it('unknown：保守省略一切可选参数', () => {
    const q = quirksFor('custom-model')
    expect(q.reasoningEffort('high')).toBeNull()
    expect(q.thinkingWithEffort).toBe(false)
    expect(q.maxTokensKey).toBe('max_tokens')
    expect(q.trimStop(['a', 'b'])).toEqual(['a', 'b'])
    expect(q.emitStreamOptions).toBe(true)
    expect(q.structuredMode).toBe('none')
  })
})

// ── 能力维度（新增） ──

describe('能力维度：toolUse / toolChoiceMode', () => {
  it('claude：toolUse ✓ + toolChoiceMode named', () => {
    const q = quirksFor('claude-sonnet-5')
    expect(q.toolUse).toBe(true)
    expect(q.toolChoiceMode).toBe('named')
  })

  it('gpt：toolUse ✓ + toolChoiceMode named', () => {
    const q = quirksFor('gpt-5.1')
    expect(q.toolUse).toBe(true)
    expect(q.toolChoiceMode).toBe('named')
  })

  it('deepseek：toolUse ✓ + toolChoiceMode required（官方仅 auto/none/required，无指名）', () => {
    const q = quirksFor('deepseek-v4-pro')
    expect(q.toolUse).toBe(true)
    expect(q.toolChoiceMode).toBe('required')
  })

  it('glm：toolUse ✓ + toolChoiceMode auto（官方明写仅 auto）', () => {
    const q = quirksFor('glm-5.2')
    expect(q.toolUse).toBe(true)
    expect(q.toolChoiceMode).toBe('auto')
  })

  it('kimi k3：toolUse ✓ + toolChoiceMode required（指名与思考不兼容）', () => {
    const q = quirksFor('kimi-k3')
    expect(q.toolUse).toBe(true)
    expect(q.toolChoiceMode).toBe('required')
  })

  it('kimi k2：toolUse ✓ + toolChoiceMode auto', () => {
    const q = quirksFor('k2.7-code')
    expect(q.toolUse).toBe(true)
    expect(q.toolChoiceMode).toBe('auto')
  })

  it('grok：toolUse ✓ + toolChoiceMode named', () => {
    const q = quirksFor('grok-4.6')
    expect(q.toolUse).toBe(true)
    expect(q.toolChoiceMode).toBe('named')
  })

  it('unknown：toolUse ✓（尝试）+ toolChoiceMode auto', () => {
    const q = quirksFor('custom-model')
    expect(q.toolUse).toBe(true)
    expect(q.toolChoiceMode).toBe('auto')
  })
})

// ── effort 词汇表 + 档位收敛（新增） ──

describe('effortMap + reasoningEffort（2026-08-14 定稿：全透传，deepseek 唯一特例）', () => {
  it('claude：无 effortMap（anthropic 线 output_config 原生全收）', () => {
    const q = quirksFor('claude-sonnet-5')
    expect(q.effortMap).toBeUndefined()
  })

  it('gpt：无 effortMap + reasoning_effort 透传（七档全收，不预演折叠）', () => {
    const q = quirksFor('gpt-5.1')
    expect(q.effortMap).toBeUndefined()
    expect(q.reasoningEffort('xhigh')).toBe('xhigh')
    expect(q.reasoningEffort('max')).toBe('max')
  })

  it('deepseek：唯一 effortMap 特例（medium→high、xhigh→max，cherry 出处）', () => {
    const q = quirksFor('deepseek-v4-pro')
    expect(q.effortMap).toEqual({ medium: 'high', xhigh: 'max' })
    expect(q.reasoningEffort('medium')).toBe('high')
    expect(q.reasoningEffort('xhigh')).toBe('max')
  })

  it('glm 5.2+：无 effortMap + 透传（官方折叠是服务端行为）', () => {
    const q = quirksFor('glm-5.2')
    expect(q.effortMap).toBeUndefined()
    expect(q.reasoningEffort('medium')).toBe('medium')
    expect(q.reasoningEffort('xhigh')).toBe('xhigh')
    expect(q.reasoningEffort('max')).toBe('max')
  })

  it('glm 4.x：不支持 effort', () => {
    const q = quirksFor('glm-4.6')
    expect(q.reasoningEffort('high')).toBeNull()
    expect(q.effortMap).toBeUndefined()
  })

  it('kimi k3：无 effortMap + 透传（官方未声明折叠方向）', () => {
    const q = quirksFor('kimi-k3')
    expect(q.effortMap).toBeUndefined()
    expect(q.reasoningEffort('medium')).toBe('medium')
    expect(q.reasoningEffort('xhigh')).toBe('xhigh')
  })

  it('kimi k2：不支持 effort', () => {
    const q = quirksFor('k2.7-code')
    expect(q.reasoningEffort('high')).toBeNull()
    expect(q.effortMap).toBeUndefined()
  })

  it('grok：无 effortMap + 透传', () => {
    const q = quirksFor('grok-4.6')
    expect(q.effortMap).toBeUndefined()
    expect(q.reasoningEffort('xhigh')).toBe('xhigh')
  })

  it('unknown：不支持 effort', () => {
    const q = quirksFor('custom-model')
    expect(q.reasoningEffort('high')).toBeNull()
    expect(q.effortMap).toBeUndefined()
  })
})

// ── maxOutputTokens（新增） ──

describe('maxOutputTokens', () => {
  it('claude：有安全默认值', () => {
    expect(quirksFor('claude-sonnet-5').maxOutputTokens).toBe(16_384)
  })
  it('grok：128000（官方默认）', () => {
    expect(quirksFor('grok-4.6').maxOutputTokens).toBe(128_000)
  })
  it('deepseek：384000（v4-pro 最大）', () => {
    expect(quirksFor('deepseek-v4-pro').maxOutputTokens).toBe(384_000)
  })
  it('gpt/glm/kimi/unknown：undefined（无可靠单一值）', () => {
    expect(quirksFor('gpt-5.1').maxOutputTokens).toBeUndefined()
    expect(quirksFor('glm-5.2').maxOutputTokens).toBeUndefined()
    expect(quirksFor('kimi-k3').maxOutputTokens).toBeUndefined()
    expect(quirksFor('custom-model').maxOutputTokens).toBeUndefined()
  })
})

// ── Anthropic 线格式维度（新增） ──

describe('Anthropic 线格式：anthropicEffortWire / parallelControl / echoReasoning', () => {
  it('claude：output_config + parallelControl ✓ + echoReasoning ✗', () => {
    const q = quirksFor('claude-sonnet-5')
    expect(q.anthropicEffortWire).toBe('output_config')
    expect(q.parallelControl).toBe(true)
    expect(q.echoReasoning).toBe(false)
  })

  it('deepseek：output_config + parallelControl ✗（恒开）+ echoReasoning ✓', () => {
    const q = quirksFor('deepseek-v4-pro')
    expect(q.anthropicEffortWire).toBe('output_config')
    expect(q.parallelControl).toBe(false)
    expect(q.echoReasoning).toBe(true)
  })

  it('glm：effortWire null + parallelControl ✗ + echoReasoning ✓', () => {
    const q = quirksFor('glm-5.2')
    expect(q.anthropicEffortWire).toBeNull()
    expect(q.parallelControl).toBe(false)
    expect(q.echoReasoning).toBe(true)
  })

  it('kimi：effortWire null + parallelControl ✓ + echoReasoning ✓', () => {
    const q = quirksFor('kimi-k3')
    expect(q.anthropicEffortWire).toBeNull()
    expect(q.parallelControl).toBe(true)
    expect(q.echoReasoning).toBe(true)
  })

  it('grok：effortWire null（anthropic 已弃用）', () => {
    const q = quirksFor('grok-4.6')
    expect(q.anthropicEffortWire).toBeNull()
  })

  it('unknown：全部保守', () => {
    const q = quirksFor('custom-model')
    expect(q.anthropicEffortWire).toBeNull()
    expect(q.parallelControl).toBe(false)
    expect(q.echoReasoning).toBe(false)
  })
})

// ── Responses 线格式子表（Responses 启用批 R2a，2026-08-17）──

describe('responsesWire 子表（R2a）', () => {
  it('gpt-5：responsesQuirksFor 覆盖后 named / json_schema / echoReasoning encrypted', () => {
    const q = responsesQuirksFor('gpt-5')
    expect(q.toolChoiceMode).toBe('named')
    expect(q.structuredMode).toBe('json_schema')
    expect(q.responsesWire.echoReasoning).toBe('encrypted')
  })

  it('grok-4：effortWire reasoning_effort + maxTokensIncludesReasoning true + echoReasoning strip', () => {
    const q = responsesQuirksFor('grok-4')
    expect(q.responsesWire.effortWire).toBe('reasoning_effort')
    expect(q.responsesWire.maxTokensIncludesReasoning).toBe(true)
    expect(q.responsesWire.echoReasoning).toBe('strip')
  })

  it('deepseek-v4：覆盖后 toolChoiceMode required / structuredMode json_object（不发 text.format）', () => {
    const q = responsesQuirksFor('deepseek-v4')
    expect(q.toolChoiceMode).toBe('required')
    expect(q.structuredMode).toBe('json_object')
  })

  it('未知模型 some-model：保守兜底 auto / none / strip', () => {
    const q = responsesQuirksFor('some-model')
    expect(q.toolChoiceMode).toBe('auto')
    expect(q.structuredMode).toBe('none')
    expect(q.responsesWire.echoReasoning).toBe('strip')
  })

  it('quirksFor 原值不受影响（覆盖只发生在 responsesQuirksFor 视图）', () => {
    // gpt 基表 toolChoiceMode 本就是 named（Chat 线视角不漂移）
    expect(quirksFor('gpt-5').toolChoiceMode).toBe('named')
    // deepseek 基表 structuredMode 与 responsesWire 子表一致（json_object，无漂移）
    const ds = quirksFor('deepseek-v4')
    expect(ds.structuredMode).toBe('json_object')
    expect(ds.structuredMode).toBe(ds.responsesWire.structuredMode)
    // gpt 基表 structuredMode（json_schema）与子表一致
    const gpt = quirksFor('gpt-5')
    expect(gpt.structuredMode).toBe(gpt.responsesWire.structuredMode)
    // unknown 基表 structuredMode=none 与兜底子表一致
    const unk = quirksFor('some-model')
    expect(unk.structuredMode).toBe(unk.responsesWire.structuredMode)
  })
})
