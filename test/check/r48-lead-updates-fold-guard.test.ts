/**
 * R48-4（四十八轮）回归：R33-6「分组标题段前备注不折入上一条证据」守卫的
 * `---` 分隔线绕过收口。
 *
 * 原实现「所有 `-` 开头行先重置 skipFoldUntilEntry 再判条目」，`---` 恰在重置后才被
 * R28-10 静默跳过——序列「条目 → ATX 标题（skipFold=true）→ --- → 普通备注行」中，
 * 备注折入上一节证据（evidenceNeedles 命中必败 → lead-declared-not-done 假红硬阻断
 * 定稿，且 lead-finalize 把污染证据持久写进履历）。修复 = 静默跳过形态（`---`/嵌套
 * 子列表）先行 continue，守卫重置收窄到真条目。
 */
import { test, expect } from 'vitest'
import { parseLeadUpdateLines } from '../../src/check/lead-updates.js'

test('R48-4: 标题后 `---` 分隔线不再绕过守卫——后续备注不折入上一条证据', () => {
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

test('R48-4: 嵌套子列表行维持守卫现值（标题后备注经子列表行仍不折入）', () => {
  const text = [
    '- 成长线-001 突破：他终于迈出了那一步',
    '## 手工备注',
    '  - 子列表行（非条目）',
    '子列表后的备注同样不折入',
  ].join('\n')
  const out = parseLeadUpdateLines(text)
  expect(out).toHaveLength(1)
  expect(out[0]!.证据).toBe('他终于迈出了那一步')
})

test('R48-4: 无标题场景 `---` 后备注不折入（重审-06 修正旧钉值）；普通续行折入不回归（R73-23）', () => {
  // 重审-06（2026-09-07 全量代码重审 §四.6）：本用例原钉死「无标题介入时 `---` 前后
  // 备注照旧折入」的旧行为——裸分隔线现升格为小节边界（与 ATX 标题同待遇），其后
  // 备注不折入；R73-23 的普通相邻行折入口径不变（见第二断言）。
  expect(parseLeadUpdateLines('- A-1 兑现：第一句\n---\n第二段备注')).toEqual([
    { leadId: 'A-1', 动词: '兑现', 证据: '第一句' },
  ])
  // 普通 R73-23 折入不回归
  expect(parseLeadUpdateLines('- A-1 兑现：第一句\n第二句续行')).toEqual([
    { leadId: 'A-1', 动词: '兑现', 证据: '第一句 第二句续行' },
  ])
})
