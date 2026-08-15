/**
 * 归一化管线单测（批次 D3）。
 *
 * 三条踩坑回归（cherry normalize.ts 照抄口径）：
 * ① 不动点循环——尾部日期遮内层变体；
 * ② 日期快照须合法月份/日期；
 * ③ 变体后缀保守表（-medium/-mini 是真型号名，永不剥）。
 * 外加 detectFamily 三键解析集成：组织前缀 / 冒号尺寸 / 大小写变体。
 */
import { describe, expect, it } from 'vitest'
import { modelIdKeys, normalizeModelId } from '../../../src/ai/provider/normalize.js'
import { detectFamily } from '../../../src/ai/provider/model-quirks.js'

describe('normalizeModelId 基础管线', () => {
  it('小写 + trim + 下划线折叠', () => {
    expect(normalizeModelId('  GLM_5.2  ')).toBe('glm-5.2')
  })

  it('剥组织前缀（单层 / 嵌套循环剥净）', () => {
    expect(normalizeModelId('deepseek-ai/deepseek-chat')).toBe('deepseek-chat')
    expect(normalizeModelId('openrouter/deepseek/deepseek-v4')).toBe('deepseek-v4')
    expect(normalizeModelId('zai-org/glm-4.7')).toBe('glm-4.7')
  })

  it('冒号尺寸转连字符；sized 保留 / norm 剥尺寸段', () => {
    expect(modelIdKeys('gpt-oss:20b')).toEqual({
      raw: 'gpt-oss:20b',
      sized: 'gpt-oss-20b',
      norm: 'gpt-oss',
    })
    // 多段尺寸（总量 + 激活参数）逐段剥净（不动点）
    expect(modelIdKeys('qwen3-235b-a22b').norm).toBe('qwen3')
    expect(modelIdKeys('qwen3-235b-a22b').sized).toBe('qwen3-235b-a22b')
  })
})

describe('踩坑①：不动点循环剥后缀', () => {
  it('尾部日期遮内层变体——两趟剥净', () => {
    // 单趟剥 -20260815 后 -preview 仍暴露；不动点继续剥
    expect(normalizeModelId('model-x-20260815-preview')).toBe('model-x')
  })
})

describe('踩坑②：日期快照须合法日历', () => {
  it('MMDD 合法即剥（gpt-4-0125 = 1月25日）', () => {
    expect(normalizeModelId('gpt-4-0125')).toBe('gpt-4')
  })

  it('MMDD 非法月份永不剥', () => {
    expect(normalizeModelId('gpt-4-9900')).toBe('gpt-4-9900')
  })

  it('YYYYMMDD 合法即剥（20250219 = 2025-02-19）', () => {
    expect(normalizeModelId('claude-sonnet-4-20250219')).toBe('claude-sonnet-4')
  })

  it('glm-4-9b / qwen3-235b 不匹配日期形态（9b/235b 非纯数字）', () => {
    expect(normalizeModelId('glm-4-9b', { keepParameterSize: true })).toBe('glm-4-9b')
    expect(normalizeModelId('qwen3-235b', { keepParameterSize: true })).toBe('qwen3-235b')
  })
})

describe('踩坑③：变体后缀保守表', () => {
  it('-latest/-preview 剥；-medium/-mini 是真型号名永不剥', () => {
    expect(normalizeModelId('llama-4-maverick-latest')).toBe('llama-4-maverick')
    expect(normalizeModelId('gemini-flash-preview')).toBe('gemini-flash')
    expect(normalizeModelId('mistral-medium')).toBe('mistral-medium')
    expect(normalizeModelId('o3-mini')).toBe('o3-mini')
  })

  it('量化后缀剥（q4_0 先于下划线折叠剥除）', () => {
    expect(normalizeModelId('glm-4.7-q4_0')).toBe('glm-4.7')
    expect(normalizeModelId('glm-4.7-awq')).toBe('glm-4.7')
  })
})

describe('detectFamily 三键解析（批次 D3）', () => {
  it('原文可判即判（快路不进归一化）', () => {
    expect(detectFamily('gpt-5.1')).toBe('gpt')
    expect(detectFamily('k3')).toBe('kimi')
  })

  it('组织前缀 / 冒号尺寸 / 大小写经归一化命中', () => {
    expect(detectFamily('zai-org/glm-4.7')).toBe('glm')
    expect(detectFamily('deepseek-ai/deepseek-chat')).toBe('deepseek')
    expect(detectFamily('anthropic/claude-sonnet-5')).toBe('claude')
    expect(detectFamily('moonshotai/kimi-k2')).toBe('kimi')
    expect(detectFamily('gpt-oss:20b')).toBe('gpt')
    expect(detectFamily('Grok-4')).toBe('grok')
  })

  it('三道全不中 → unknown（宁缺勿错）', () => {
    expect(detectFamily('custom-model')).toBe('unknown')
    expect(detectFamily('org/unknown-v2')).toBe('unknown')
  })
})
