/**
 * C1 金测：prompt 资源化迁移的「字节等价」锁。
 *
 * 夹具 prompts-golden.json 是 C1 重构前对旧整段字符串常量的逐字快照。
 * 无论 prompt 源头怎么换（代码常量 → 段组装 → C2 资源文件），导出常量
 * 必须与快照逐字节相等——否则前缀缓存/行为/内容哈希迁移链全部失真。
 * 内置 prompt 文案迭代时：改资源文件 → 同步更新本夹具 → versions.json 追加旧哈希。
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
const golden = JSON.parse(
  readFileSync(new URL('./__fixtures__/prompts-golden.json', import.meta.url), 'utf8'),
) as Record<string, string>
import { WRITER_SYSTEM_LONG, WRITER_SYSTEM_SHORT, REWRITER_SYSTEM } from '../../src/ai/prompts/writer.js'
import { ANALYST_SYSTEM } from '../../src/ai/prompts/analyst.js'
import { REVIEW_SYSTEMS, REVIEW_COMMON } from '../../src/ai/prompts/review.js'

describe('C1 金测：段组装与旧整段常量字节等价', () => {
  it('writer：长/短/改写', () => {
    expect(WRITER_SYSTEM_LONG).toBe(golden['writer-long'])
    expect(WRITER_SYSTEM_SHORT).toBe(golden['writer-short'])
    expect(REWRITER_SYSTEM).toBe(golden['rewriter'])
  })

  it('analyst', () => {
    expect(ANALYST_SYSTEM).toBe(golden['analyst'])
  })

  it('review：八视角 + 通用 fallback', () => {
    expect(REVIEW_COMMON).toBe(golden['review-common'])
    for (const lens of [
      'reader',
      'editor',
      'continuity',
      'disclosure',
      'plot_causality',
      'hook',
      'emotion_peak',
      'payoff',
    ]) {
      expect(REVIEW_SYSTEMS[lens]).toBe(golden[`review-${lens}`])
    }
  })
})
