/**
 * trace 模块单测（AI Harness T2）。
 *
 * 覆盖：promptMeta 脱敏（不落原文）、runId 唯一性。
 * Z-P2-3：文件写入层（appendTrace/readTraceLines/轮转/损坏行容错）已随死代码移除
 * （被事件库 llm/call 替代），落盘路径由事件库测试覆盖。
 */
import { describe, expect, it } from 'vitest'
import { promptMeta, newRunId } from '../../src/ai/trace.js'

describe('promptMeta 脱敏', () => {
  it('只记录字符数 + hash，不落原文', () => {
    const text = '这是一段需要脱敏的 prompt 文本，不应出现在 trace 中'
    const meta = promptMeta('', text)

    expect(meta.chars).toBe(text.length)
    expect(meta.hash).toHaveLength(16)
    expect(meta.hash).toMatch(/^[0-9a-f]+$/)
    // 确认原文不在 meta 中
    expect(JSON.stringify(meta)).not.toContain('需要脱敏')
  })

  it('相同 prompt → 相同 hash', () => {
    const text = '一致性测试'
    expect(promptMeta('', text).hash).toBe(promptMeta('', text).hash)
  })

  it('不同 prompt → 不同 hash', () => {
    expect(promptMeta('', 'A').hash).not.toBe(promptMeta('', 'B').hash)
  })
})

describe('runId 唯一性', () => {
  it('每次调用生成不同 ID', () => {
    const ids = new Set<string>()
    for (let i = 0; i < 100; i++) ids.add(newRunId())
    expect(ids.size).toBe(100)
  })
})
