/**
 * C1 金测：PromptSection 重构/资源化迁移的「字节等价」锁。
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
import { assembleSections, interpolate, SECTION_ORDER } from '../../src/ai/prompts/section.js'

describe('C1 金测：段组装与旧整段常量字节等价', () => {
  it('writer：长/短/改写', () => {
    expect(WRITER_SYSTEM_LONG).toBe(golden['writer-long'])
    expect(WRITER_SYSTEM_SHORT).toBe(golden['writer-short'])
    expect(REWRITER_SYSTEM).toBe(golden['rewriter'])
  })

  it('analyst', () => {
    expect(ANALYST_SYSTEM).toBe(golden['analyst'])
  })

  it('review：六视角 + 通用 fallback', () => {
    expect(REVIEW_COMMON).toBe(golden['review-common'])
    for (const lens of ['reader', 'editor', 'continuity', 'hook', 'emotion_peak', 'payoff']) {
      expect(REVIEW_SYSTEMS[lens]).toBe(golden[`review-${lens}`])
    }
  })
})

describe('C1 assembleSections 语义', () => {
  it('order 升序稳定排序（同 order 按传入序）', () => {
    const out = assembleSections([
      { name: 'b', order: 200, text: 'B' },
      { name: 'a', order: 0, text: 'A' },
      { name: 'b2', order: 200, text: 'B2' },
    ])
    expect(out).toBe('A\n\nB\n\nB2')
  })

  it('complete 段独占：单段直出，多段同席 throw', () => {
    expect(assembleSections([{ name: 'solo', order: 0, text: '全文', complete: true }])).toBe('全文')
    expect(() =>
      assembleSections([
        { name: 'solo', order: 0, text: '全文', complete: true },
        { name: 'other', order: 100, text: 'X' },
      ]),
    ).toThrow('独占')
  })

  it('{{variable}} 插值：提供的替换，未提供的原样保留', () => {
    const out = assembleSections(
      [{ name: 's', order: 0, text: '写第 {{chapter}} 章，{{unknown}} 保留' }],
      { chapter: '3' },
    )
    expect(out).toBe('写第 3 章，{{unknown}} 保留')
  })

  it('分层优先级契约带存在且有序（平台约束 < 写作风格 < 设定数据）', () => {
    expect(SECTION_ORDER.PLATFORM).toBeLessThan(SECTION_ORDER.STYLE)
    expect(SECTION_ORDER.STYLE).toBeLessThan(SECTION_ORDER.SETTINGS)
    expect(interpolate('{{a}}', { a: 'x' })).toBe('x')
  })
})
