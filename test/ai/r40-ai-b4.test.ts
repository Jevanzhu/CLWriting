/**
 * R40 B4 域（AI 链路辅助件+格式）修复批回归。
 *
 * - R40-6：prompt canonicalize 补 CRLF→LF 归一——同文异行尾同指纹（跨机对账）。
 * - R40-7：readRuleHits 出口逐条形状校验——坏行跳过 + warn 留痕（trace-stats 直透
 *   前端前的防线）。
 * - R40-8：预算闸显式 0 =「一次都不许调」——首调路径不再放行。
 * - R40-13：readDraft 无 content 参单读派生（行为等价回归——同快照派生 hash 与 body）。
 */
import { describe, expect, it, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promptHash } from '../../src/ai/prompts/resource.js'
import { readRuleHits } from '../../src/ai/rule-hits.js'
import { checkAiCallBudget } from '../../src/ai/calls.js'
import { readDraft } from '../../src/format/draft.js'
import { log } from '../../src/log/index.js'
import type { BookConfig } from '../../src/format/types.js'

const dirs: string[] = []
function tempBook(prefix = 'clw-r40-ai-'): string {
  const d = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(d)
  return d
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
  vi.restoreAllMocks()
})

describe('R40-6: prompt 指纹跨行尾一致', () => {
  it('CRLF 与 LF 同文同哈希；BOM 剥除保持', () => {
    const lf = '# 角色设定\n\n你是长篇写作助手。\n'
    expect(promptHash(lf.replace(/\n/g, '\r\n'))).toBe(promptHash(lf))
    expect(promptHash('\uFEFF' + lf)).toBe(promptHash(lf))
  })
})

describe('R40-7: readRuleHits 坏行跳过', () => {
  it('坏形状条目跳过 + warn 留痕，好条目照常返回', () => {
    const root = tempBook()
    mkdirSync(join(root, '.cache'), { recursive: true })
    writeFileSync(
      join(root, '.cache', 'rule-hits.json'),
      JSON.stringify({
        good: { ruleId: 'g1', hits: 2, lastHit: 't', recentMessages: ['m1'] },
        badType: { ruleId: 'b1', hits: ' many ', lastHit: 't', recentMessages: [] },
        badNull: null,
      }),
      'utf-8',
    )
    const warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => {})
    const hits = readRuleHits(root)
    expect(hits.map((h) => h.ruleId)).toEqual(['g1'])
    expect(warnSpy).toHaveBeenCalled()
  })

  it('全部合法 → 零告警', () => {
    const root = tempBook()
    mkdirSync(join(root, '.cache'), { recursive: true })
    writeFileSync(
      join(root, '.cache', 'rule-hits.json'),
      JSON.stringify({ a: { ruleId: 'a', hits: 1, lastHit: 't', recentMessages: [] } }),
      'utf-8',
    )
    const warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => {})
    expect(readRuleHits(root)).toHaveLength(1)
    expect(warnSpy).not.toHaveBeenCalled()
  })
})

describe('R40-8: 预算闸显式 0 语义', () => {
  it('calls_per_chapter: 0 → 首调即拦（可读文案）', () => {
    const root = tempBook()
    const b = checkAiCallBudget(root, 1, { budget: { calls_per_chapter: 0 } } as unknown as BookConfig)
    expect(b.ok).toBe(false)
    if (!b.ok) expect(b.reason).toContain('一次都不许调')
  })

  it('未设置 → 全局托底正常放行（?? 链不回归）', () => {
    const root = tempBook()
    const b = checkAiCallBudget(root, 1, { budget: {} } as unknown as BookConfig)
    expect(b.ok).toBe(true)
  })
})

describe('R40-13: readDraft 单读派生（行为等价）', () => {
  it('无 content 参 → 正常解析（chapter meta 与 body 同源）', () => {
    const root = tempBook()
    const fp = join(root, '0003-试炼.md')
    writeFileSync(fp, '---\n章号: 3\n标题: 试炼\n---\n\n正文内容在此。\n', 'utf-8')
    const r = readDraft(fp)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.chapter.章号).toBe(3)
      expect(r.body).toContain('正文内容在此。')
    }
  })

  it('文件缺失 → 既有文案不回归', () => {
    const r = readDraft(join(tempBook(), '不存在.md'))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain('找不到文件')
  })
})
