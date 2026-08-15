/**
 * checkpoint 模板 + 输出钳制单测（批次 B2 / CS-11 + DSH-4）：
 * - 8 段模板逐字结构（英文段名防漂移 + 中文括注）
 * - 合并指令只在有先前存档时出现
 * - 输出钳制 clamp(window*0.25, 4096, 16384)
 * - extractPriorSummary 标记提取
 */
import { describe, it, expect } from 'vitest'
import {
  CHECKPOINT_SECTIONS,
  CHECKPOINT_TAG_OPEN,
  CHECKPOINT_TAG_CLOSE,
  buildCheckpointInstruction,
  extractPriorSummary,
  clampCheckpointOutputTokens,
  COMPRESSION_MIN_OUTPUT_TOKENS,
  COMPRESSION_MAX_OUTPUT_TOKENS,
} from '../../src/ai/prompts/checkpoint.js'

describe('buildCheckpointInstruction', () => {
  it('含 8 段英文段名（防漂移）+ 中文括注', () => {
    const ins = buildCheckpointInstruction()
    for (const s of CHECKPOINT_SECTIONS) expect(ins).toContain(s)
    expect(CHECKPOINT_SECTIONS.length).toBe(8)
    expect(ins).toContain('Primary Request and Intent')
    expect(ins).toContain('(none)') // 空段写 (none) 绝不丢段
  })

  it('规则：保留精确信息 / 不提摘要请求本身', () => {
    const ins = buildCheckpointInstruction()
    expect(ins).toContain('章节号、数字、文件名')
    expect(ins).toContain('不要提及本次摘要请求本身')
  })

  it('合并而非复制：有先前存档才出现合并指令', () => {
    const fresh = buildCheckpointInstruction()
    const merge = buildCheckpointInstruction('旧存档正文')
    expect(fresh).not.toContain('合并进本次存档')
    expect(merge).toContain('合并进本次存档')
    expect(merge).toContain('唯一一份累计')
  })
})

describe('extractPriorSummary', () => {
  it('提取标记内正文（trim）', () => {
    const text = `前导说明\n\n${CHECKPOINT_TAG_OPEN}\n  存档正文第1行\n存档正文第2行  \n${CHECKPOINT_TAG_CLOSE}\n后续`
    expect(extractPriorSummary(text)).toBe('存档正文第1行\n存档正文第2行')
  })

  it('无标记 → null；标记内为空 → null', () => {
    expect(extractPriorSummary('普通消息')).toBeNull()
    expect(extractPriorSummary(`${CHECKPOINT_TAG_OPEN}   ${CHECKPOINT_TAG_CLOSE}`)).toBeNull()
  })
})

describe('clampCheckpointOutputTokens', () => {
  it('预算 = window*0.25，夹在 [4096, 16384]', () => {
    expect(clampCheckpointOutputTokens(100_000)).toBe(16_384) // 25000 > 16384 → 上限
    expect(clampCheckpointOutputTokens(65_536)).toBe(16_384) // 65536*0.25 = 16384 恰好
    expect(clampCheckpointOutputTokens(40_000)).toBe(10_000) // 区间内
    expect(clampCheckpointOutputTokens(8_000)).toBe(COMPRESSION_MIN_OUTPUT_TOKENS) // 2000 < 4096 → 下限
    expect(clampCheckpointOutputTokens(0)).toBe(COMPRESSION_MAX_OUTPUT_TOKENS) // 未知窗口 → 上限（宁可多给）
    expect(clampCheckpointOutputTokens(Number.NaN)).toBe(COMPRESSION_MAX_OUTPUT_TOKENS)
    expect(clampCheckpointOutputTokens()).toBe(COMPRESSION_MAX_OUTPUT_TOKENS)
  })
})
