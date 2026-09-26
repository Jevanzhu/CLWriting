/**
 * maxAdjStack 的解析夹取与回溯守卫：形容词连续堆叠检查的耗时与语义防线。
 *
 * 档源（2 档并 1，按被测行为合并；断言逐条保留、去重 0 条）：
 * - r0912-check-fix-batch.test.ts 的 R0912-F-P2-1 组（同文件 P3-1/P3-2 组分别并入
 *   quotes-matrix.test.ts 与 roster-new-names.test.ts）
 * - r27-batch-b.test.ts 的 R27-23 组（同文件其余组属 format 解析守卫家族，
 *   另拆 format-parse-guards.test.ts）
 *
 * - R27-23（二十七轮）：parseIronRules maxAdjStack 夹取 [0,20]——手滑多打 0 直通
 *   `{N+1,}` 量词指数回退（实测秒级）。
 * - R0912-F-P2-1（R0912 修复批）：adjStack 回溯守卫收紧 {8,}→{3,}——病理片段
 *   耗时上界 + 命中为空；正常堆叠语义锚；3-4 连「的」不误报垃圾匹配。
 */
import { test, expect } from 'vitest'
import { parseIronRules } from '../../src/format/iron-rules.js'
import { checkStyleMetrics, computeStyleMetrics } from '../../src/check/count.js'

test('R27-23: parseIronRules maxAdjStack 上界夹取', () => {
  expect(parseIronRules('形容词连续堆叠上限: 200').maxAdjStack).toBe(20)
  expect(parseIronRules('形容词连续堆叠上限：3').maxAdjStack).toBe(3)
  // 未配置语义不变
  expect(parseIronRules('无配置文本').maxAdjStack).toBeUndefined()
})

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
