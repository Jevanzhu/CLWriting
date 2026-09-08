/**
 * 重审-06（2026-09-07 全量代码重审 §四.6）回归：账本推进解析的裸 `---` 分隔线
 * （无 ATX 标题前置）视作小节边界。
 *
 * R48-4 只堵了「ATX 标题 → ---」序（分隔线维持 skipFold 守卫现值）；条目直接 →
 * `---` → 自由备注行仍折入上一条证据 → 证据污染 → evidenceNeedles 命中必败 →
 * lead-declared-not-done 假红硬阻断定稿 + lead-finalize 把污染证据持久写进履历。
 * 修复 = `---` 分隔线命中即置 skipFoldUntilEntry = true（与 ATX 标题同待遇）。
 */
import { test, expect } from 'vitest'
import { parseLeadUpdateLines } from '../../src/check/lead-updates.js'

test('重审-06: 条目 → 裸 `---` → 备注行——备注不折入、条目原样（现状折入 → 红）', () => {
  const text = [
    '- 成长线-001 突破：他终于迈出了那一步',
    '---',
    '分隔线后的手写备注不得污染证据',
  ].join('\n')
  const out = parseLeadUpdateLines(text)
  expect(out).toHaveLength(1)
  expect(out[0]!.证据).toBe('他终于迈出了那一步')
})

test('重审-06: `---` 后出现真条目 → 守卫被条目重置，新条目照常解析', () => {
  const text = [
    '- 成长线-001 突破：他终于迈出了那一步',
    '---',
    '分隔线后的手写备注不得污染证据',
    '- 悬念-002 树立：井底的灯又亮了',
  ].join('\n')
  const out = parseLeadUpdateLines(text)
  expect(out).toHaveLength(2)
  expect(out[0]!.证据).toBe('他终于迈出了那一步')
  expect(out[1]!.证据).toBe('井底的灯又亮了')
})

test('重审-06: 不回归 R48-4——标题 → `---` → 备注仍不折入（既有守卫口径不变）', () => {
  const text = [
    '- 成长线-001 突破：他终于迈出了那一步',
    '## 手工备注',
    '---',
    '分隔线后的手写内容不要污染证据',
    '- 悬念-002 树立：井底的灯又亮了',
  ].join('\n')
  const out = parseLeadUpdateLines(text)
  expect(out).toHaveLength(2)
  expect(out[0]!.证据).toBe('他终于迈出了那一步')
  expect(out[1]!.证据).toBe('井底的灯又亮了')
})

test('重审-06: 不回归 R73-23——无分隔线的普通相邻行仍折入上一条证据', () => {
  expect(parseLeadUpdateLines('- A-1 兑现：第一句\n第二句续行')).toEqual([
    { leadId: 'A-1', 动词: '兑现', 证据: '第一句 第二句续行' },
  ])
})
