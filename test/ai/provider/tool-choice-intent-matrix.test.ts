/**
 * R0912-3（2026-09-12 全量代码重评修复批 #50）：tool_choice 分档决策单源直接单测。
 *
 * resolveToolChoiceIntent（R0912-D-P3-3 收敛）此前仅由三适配器（openai/anthropic/
 * responses）的 wire 发射断言间接守护，toolChoiceMode × toolChoice 的 4×4 组合空间
 * 未被钉定。本文件对决策函数按档位（= 供应商/模型族 quirk 档）× 意图全组合逐格断言
 * 输出（含 toolName 有无双态），防分档口径漂移。不改源码，期望值逐格照录现行实现。
 */
import { describe, expect, it } from 'vitest'
import { resolveToolChoiceIntent } from '../../../src/ai/provider/tool-choice.js'
import type { ToolChoiceIntent } from '../../../src/ai/provider/tool-choice.js'

const TOOL_NAME = 'submit_text'

/** 单格断言：mode × 意图 × toolName 有无 → 决策输出精确匹配（toEqual 钉键集） */
function expectCell(
  mode: 'named' | 'required' | 'auto' | 'none',
  toolChoice: 'any' | 'tool' | 'auto' | undefined,
  toolName: string | undefined,
  expected: ToolChoiceIntent,
): void {
  expect(
    resolveToolChoiceIntent({ toolChoiceMode: mode, toolChoice, toolName }),
  ).toEqual(expected)
}

describe('R0912-3：resolveToolChoiceIntent 全组合空间（mode × intent × toolName）', () => {
  it('named：强制意图按请求形态分指名/不指名，auto 照发', () => {
    expectCell('named', 'any', TOOL_NAME, { action: 'force' })
    expectCell('named', 'any', undefined, { action: 'force' })
    expectCell('named', 'tool', TOOL_NAME, { action: 'force-named', name: TOOL_NAME })
    expectCell('named', 'tool', undefined, { action: 'none' }) // 'tool' 无 toolName → 不发
    expectCell('named', 'auto', TOOL_NAME, { action: 'auto' })
    expectCell('named', 'auto', undefined, { action: 'auto' })
    expectCell('named', undefined, TOOL_NAME, { action: 'none' }) // 缺省意图 → 不发
    expectCell('named', undefined, undefined, { action: 'none' })
  })

  it('required：强制意图一律降级为不指名 force（toolName 不透传），auto 照发', () => {
    expectCell('required', 'any', TOOL_NAME, { action: 'force' })
    expectCell('required', 'any', undefined, { action: 'force' })
    expectCell('required', 'tool', TOOL_NAME, { action: 'force' }) // 指名降级：无 name 键
    expectCell('required', 'tool', undefined, { action: 'force' })
    expectCell('required', 'auto', TOOL_NAME, { action: 'auto' })
    expectCell('required', 'auto', undefined, { action: 'auto' })
    expectCell('required', undefined, TOOL_NAME, { action: 'none' })
    expectCell('required', undefined, undefined, { action: 'none' })
  })

  it('auto：仅 auto 意图放行，强制意图不发（prompt 引导 + 契约层校验重试兜底）', () => {
    expectCell('auto', 'any', TOOL_NAME, { action: 'none' })
    expectCell('auto', 'any', undefined, { action: 'none' })
    expectCell('auto', 'tool', TOOL_NAME, { action: 'none' })
    expectCell('auto', 'tool', undefined, { action: 'none' })
    expectCell('auto', 'auto', TOOL_NAME, { action: 'auto' })
    expectCell('auto', 'auto', undefined, { action: 'auto' })
    expectCell('auto', undefined, TOOL_NAME, { action: 'none' })
    expectCell('auto', undefined, undefined, { action: 'none' })
  })

  it('none：协议不支持 tool_choice——恒 none（responses 线视图无 none 档，不进此分支）', () => {
    expectCell('none', 'any', TOOL_NAME, { action: 'none' })
    expectCell('none', 'any', undefined, { action: 'none' })
    expectCell('none', 'tool', TOOL_NAME, { action: 'none' })
    expectCell('none', 'tool', undefined, { action: 'none' })
    expectCell('none', 'auto', TOOL_NAME, { action: 'none' })
    expectCell('none', 'auto', undefined, { action: 'none' })
    expectCell('none', undefined, TOOL_NAME, { action: 'none' })
    expectCell('none', undefined, undefined, { action: 'none' })
  })
})
