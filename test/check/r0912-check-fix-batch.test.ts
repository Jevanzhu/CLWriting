/**
 * R0912 修复批（2026-09-12 独立重评第十篇）check 域回归：
 *
 * - R0912-F-P2-1：adjStack 回溯守卫收紧 {8,}→{3,}——①病理片段（7 连「的」×5 +
 *   断链尾）耗时上界断言 + 命中为空（主审实测 469ms→0.1ms）；②正常 25 单元堆叠
 *   命中数组语义锚（收紧前后不变）；③含 3-4 连「的」的正文不再误报垃圾匹配。
 * - R0912-F-P3-1：stripQuotedSpans 2-slot 引用 memo——同 body 两次调用返回值 ===；
 *   不同 body 各自正确（被逐出后重算内容仍对）。
 * - R0912-F-P3-2：checkNewNames 名册 Set 化——精确全等判重语义不变（长名不吞短名）。
 */
import { test, expect } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checkNewNames, computeStyleMetrics, checkStyleMetrics } from '../../src/check/count.js'
import { parseIronRules } from '../../src/format/iron-rules.js'
import { stripQuotedSpans } from '../../src/check/quotes.js'

// ── R0912-F-P2-1：adjStack 回溯守卫收紧 ──────────────────────────────

test('R0912-F-P2-1①: 病理片段（7 连「的」×5 + 断链尾）在收紧后命中为空且耗时 <250ms', () => {
  // 病理构造：每段 7 连「的」（旧界 {8,} 不切段）+ 单字断链尾，拼接后旧实现
  // 对每段做多种 {1,6} 分段回溯（分解数随段数指数乘积）。maxAdjStack=20
  //（配额 21 单元）下永不构成合法堆叠 → 收紧后命中必为空。
  const fragment = '的'.repeat(7) + '山'
  const body = fragment.repeat(5) + '的'.repeat(7) + '的尽头了'
  const rules = parseIronRules('形容词连续堆叠上限: 20')
  const t0 = performance.now()
  const stats = computeStyleMetrics(body, rules)
  const elapsed = performance.now() - t0
  expect(stats._adjStackHits).toEqual([])
  // 耗时上界：收紧后 ~0.1ms 量级，取 250ms 宽松界防 flaky；若守卫回退到 {8,}
  // 旧界，此用例按分解组合指数增长（秒级起步）——超界即判回归。
  expect(elapsed).toBeLessThan(250)
})

test('R0912-F-P2-1②: 正常 25 单元堆叠命中数组语义锚（{8,}→{3,} 收紧前后不变）', () => {
  // 25 个「苍白+的」单元：合法堆叠形态（每单元「≤6 汉字+的」，无 3 连「的」），
  // 收紧只切「≥3 连的」游程，对正常堆叠零影响——命中恒为去重后的整串一条。
  const units = '苍白的'.repeat(25)
  const rules = parseIronRules('形容词连续堆叠上限: 20')
  const stats = computeStyleMetrics(units, rules)
  expect(stats.adjStackHits).toBe(1)
  expect(stats._adjStackHits).toEqual([units])
  // 顿号分隔形态同锚（4 单元 > 上限 3）
  const r = checkStyleMetrics('幽暗的、冰冷的、古老的、腐朽的气息漫出来。', parseIronRules('形容词连续堆叠上限: 3'))
  expect(r.items.filter((i) => i.checkId === 'style-adj-stack')).toHaveLength(1)
})

test('R0912-F-P2-1③: 含「的的的/的的的的」的正文不再误报垃圾匹配', () => {
  // 4 连「的」（配额 2 单元旧实现可拆成两个空头单元命中垃圾串）；3 连「的」
  // 与后文「苍白的」拼接（旧实现可跨拼出 2 单元垃圾命中「的的的苍白的」）。
  // 收紧后 ≥3 连游程整段丢弃 → 均不再产黄。
  const rules = parseIronRules('形容词连续堆叠上限: 1')
  const r1 = checkStyleMetrics('他把的的的写成了绕口令。', rules)
  expect(r1.items.some((i) => i.checkId === 'style-adj-stack')).toBe(false)
  const r2 = checkStyleMetrics('这的的的苍白的写法实在拗口。', rules)
  expect(r2.items.some((i) => i.checkId === 'style-adj-stack')).toBe(false)
})

// ── R0912-F-P3-1：stripQuotedSpans 2-slot memo ───────────────────────

test('R0912-F-P3-1: 同 body 连续两次调用返回同一引用（memo 命中）；不同 body 各自正确', () => {
  const body = '「对白内容不算叙述。」叙述文本照常保留。'
  const first = stripQuotedSpans(body)
  const second = stripQuotedSpans(body)
  expect(second).toBe(first) // 引用相等 = memo 命中（内容相等由 toBe 同断）
  expect(first).toBe('叙述文本照常保留。')

  // 不同 body 交替：2 槽逐出后重算，内容仍各自正确
  const x = '「一」甲'
  const y = '「二」乙'
  expect(stripQuotedSpans(x)).toBe('甲')
  expect(stripQuotedSpans(y)).toBe('乙')
  expect(stripQuotedSpans(x)).toBe('甲')
  expect(stripQuotedSpans(y)).toBe('乙')
  // 无引号文本原样返回
  expect(stripQuotedSpans('纯叙述无引号。')).toBe('纯叙述无引号。')
})

// ── R0912-F-P3-2：checkNewNames 名册 Set 化（语义锚） ─────────────────

test('R0912-F-P3-2: 名册 Set 化后精确全等判重语义不变（长名不吞短名）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'r0912-roster-set-'))
  try {
    const roster = join(dir, '名册.md')
    writeFileSync(roster, '# 名册\n- 已登记：林晚晴（女主）、赵无极、苏摩、云澈\n', 'utf-8')
    // 长名「林晚晴」在册，短名「林晚」仍是候选（Set.has 精确全等，不回退 includes 旧口径）
    const r = checkNewNames('「林晚」握紧了剑，「赵无极」冷眼旁观。', roster)
    const names = r.items.filter((i) => i.checkId === 'new-name').map((i) => i.message)
    expect(names.some((m) => m.includes('林晚'))).toBe(true)
    expect(names.some((m) => m.includes('赵无极'))).toBe(false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
