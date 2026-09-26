/**
 * 账本推进（lead-updates）的证据折叠守卫与三态读：parseLeadUpdateLines /
 * readChapterUpdatesForChapterChecked。
 *
 * 档源（3 档并 1，按被测行为合并；断言逐条保留、去重 1 条——bare-divider 的
 * 「不回归 R48-4」用例与 r48-lead-updates-fold-guard 首例同输入同断言，保留后者）：
 * - r48-lead-updates-fold-guard.test.ts（R48-4：标题后 `---` 分隔线绕过收口）
 * - lead-updates-bare-divider.test.ts（重审-06：裸 `---` 视作小节边界）
 * - r33-check-fixes.test.ts 的 R33-5 / R33-6 组
 * - r33d-batch-b.test.ts 的 R33D-3 组（章标签剥 BOM）
 * - r31b-machine-correctness.test.ts 的 R31-13 组（证据针串最短 2 码位）
 *
 * 行为契约：分组标题与条目之间的备注行（含经 `---`/嵌套子列表的静默跳过形态绕行）
 * 不折入上一条证据——证据污染 → evidenceNeedles 命中必败 → lead-declared-not-done
 * 假红硬阻断定稿，且 lead-finalize 把污染证据持久写进履历。R73-23 的普通续行折入、
 * R75-2 的节终标题 break 语义不回归。读侧三态：读失败（EISDIR 瞬态占用）≠「明确
 * 无推进」——unreadable:true 让调用方跳过两端闭合（对齐声明侧 R70-15）。
 */
import { test, expect } from 'vitest'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdtempTracked } from '../helpers/temp-dir.js'
import { parseLeadUpdateLines, readChapterUpdatesForChapterChecked, readLeadUpdateChapterTag } from '../../src/check/lead-updates.js'
import { evidenceNeedles } from '../../src/check/leads.js'

// ── R48-4：标题后 `---` 分隔线不再绕过守卫 ───────────────────────

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

// ── 重审-06：裸 `---` 分隔线（无 ATX 标题前置）视作小节边界 ────────

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

test('重审-06: 不回归 R73-23——无分隔线的普通相邻行仍折入上一条证据', () => {
  expect(parseLeadUpdateLines('- A-1 兑现：第一句\n第二句续行')).toEqual([
    { leadId: 'A-1', 动词: '兑现', 证据: '第一句 第二句续行' },
  ])
})

// ── R33-6：分组标题段前备注不折入 ────────────────────────────

test('R33-6: 分组标题与后随条目之间的备注行不折入上一条证据', () => {
  const text = [
    '- 成长线-001 突破：他终于迈出了那一步',
    '## 备注',
    '手工备注内容不要污染证据',
    '- 悬念-002 树立：井底的灯又亮了',
  ].join('\n')
  const out = parseLeadUpdateLines(text)
  expect(out).toHaveLength(2)
  expect(out[0]!.证据).toBe('他终于迈出了那一步')
  expect(out[1]!.证据).toBe('井底的灯又亮了')
})

test('R33-6: 非标题场景的续行折入（R73-23）与节终标题 break（R75-2）不回归', () => {
  // R73-23 折入：无标题介入的多行证据仍折入
  expect(parseLeadUpdateLines('- A-1 兑现：第一句\n第二句续行')).toEqual([
    { leadId: 'A-1', 动词: '兑现', 证据: '第一句 第二句续行' },
  ])
  // R75-2 节终标题：标题后无条目 → 整节终止，不产生新条目
  expect(parseLeadUpdateLines('- A-1 兑现：证据在先\n## 手记\n散文备注')).toEqual([
    { leadId: 'A-1', 动词: '兑现', 证据: '证据在先' },
  ])
})

// ── R33-5：兑现侧三态读 ─────────────────────────────────────

test('R33-5: 读失败（EISDIR 瞬态占用模拟）→ unreadable:true；无文件 → 已读空推进', () => {
  const root = mkdtempTracked(join(tmpdir(), 'lead-updates-read-'))
  try {
    // 无任何文件：已读、无推进（已知态，不跳过闭合）
    expect(readChapterUpdatesForChapterChecked(root, 3)).toEqual({ updates: [], unreadable: false })
    // 主文件被目录占用（readFileSync 对目录抛错）→ unreadable:true（修复前返回 [] 被
    // leadClosureItems 判「声明了没做」假红；win 线 {ok} 形状合并入 unreadable 形状）
    mkdirSync(join(root, '工作区', '账本推进.md'), { recursive: true })
    const r = readChapterUpdatesForChapterChecked(root, 3)
    expect(r.unreadable).toBe(true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// ── R33D-3（并入档；原 r33d-batch-b.test.ts）：账本推进章标签剥 BOM ──
// 带 BOM + 章标签的账本推进此前 tag 恒 null（mainIsThisChapter 对任意章为 true →
// 跨章履历污染）。

test('R33D-3: 带 BOM 的 `\uFEFF# 第5章` → tag=5（此前恒 null）', () => {
  const root = mkdtempTracked(join(tmpdir(), 'lead-tag-bom-'))
  try {
    const fp = join(root, '账本推进.md')
    writeFileSync(fp, '\uFEFF# 第5章 账本推进\n- 悬念-001 递进：证据。\n', 'utf-8')
    expect(readLeadUpdateChapterTag(fp)).toBe(5)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('R33D-3: 无 BOM 行为不变；无标签 → null（回归）', () => {
  const root = mkdtempTracked(join(tmpdir(), 'lead-tag-bom-'))
  try {
    const fp = join(root, '账本推进.md')
    writeFileSync(fp, '# 第3章 账本推进\n', 'utf-8')
    expect(readLeadUpdateChapterTag(fp)).toBe(3)
    writeFileSync(fp, '- 无标题条目\n', 'utf-8')
    expect(readLeadUpdateChapterTag(fp)).toBeNull()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// ── R31-13（并入档；原 r31b-machine-correctness.test.ts）：证据针串最短 2 码位 ──
// 1 字针串正文几乎恒命中 → 兑现判定 trivially 通过。

test('R31-13: 1 字候选被过滤，≥2 候选保留；全 1 字时回退剥引号串 ≥2 才用', () => {
  // 「雪」无声 → inner='雪'（1 字，滤除）；edgeStripped='雪」无声'、allStripped='雪无声'
  // （均 ≥2 码位，保留——edgeStripped 内引号保留是 R63-8 既有多候选设计）
  expect(evidenceNeedles('「雪」无声')).toEqual(['雪」无声', '雪无声'])
  // 正常证据多候选不变（2+ 字都保留）
  const needles = evidenceNeedles('「雪落无声」')
  expect(needles).toContain('雪落无声')
  // 整条证据只剩 1 字 → 空数组（消费方按空针串口径：引文红闸 unverifiable 黄）
  expect(evidenceNeedles('「雪」')).toEqual([])
})
