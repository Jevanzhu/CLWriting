/**
 * R30（三十轮）机检正确性回归：名册精确判重 + 情绪曲线 NaN 强度。
 *
 * - R30-2：checkNewNames 判重由「名册全文 includes」改「已登记名字集合精确全等」
 *   （parseRosterNames 局部单源）——名册更长名字包含候选（「林晚晴」⊃「林晚」）
 *   时原实现误判已登记，独立新角色漏报。
 * - R30-14：checkPieceListForm 的 Math.max(...强度) 混入 NaN 时得 NaN，`NaN < 8`
 *   恒 false → emotion-curve-peak-low 漏判；修后计算前过滤非有限值。
 */
import { test, expect } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checkNewNames } from '../../src/check/count.js'
import { checkPieceListForm } from '../../src/check/manifest-check.js'
import type { PieceList } from '../../src/format/types.js'

// ── R30-2：名册精确判重 ──────────────────────────────────────────

test('R30-2: 名册含「林晚晴」时候选「林晚」仍报新专名（长名不再吞短名）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'clw-r30-roster-'))
  try {
    const roster = join(dir, '名册.md')
    // 名册格式兼容仓内既有形态：标题行 + 列表行 + 顿号分隔 + 括注
    writeFileSync(roster, '# 名册\n- 已登记：林晚晴（女主）、赵无极\n', 'utf-8')
    const r = checkNewNames('「林晚」握紧了剑。', roster)
    expect(r.items.some((i) => i.checkId === 'new-name' && i.message.includes('林晚'))).toBe(true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('R30-2: 「林晚晴」本身已登记不报；括注不污染精确名', () => {
  const dir = mkdtempSync(join(tmpdir(), 'clw-r30-roster-'))
  try {
    const roster = join(dir, '名册.md')
    writeFileSync(roster, '# 名册\n- 已登记：林晚晴（女主）\n', 'utf-8')
    const r = checkNewNames('「林晚晴」握紧了剑。', roster)
    expect(r.items).toHaveLength(0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('R30-2: 名册缺失 → 空结果路径不回归（不崩、零项）', () => {
  const r = checkNewNames('「林晚」握紧了剑。', join(tmpdir(), '不存在-r30-' + Date.now() + '.md'))
  expect(r.items).toHaveLength(0)
})

// ── R30-14：情绪曲线 NaN 强度不再吞掉 peak-low ────────────────────

/** 五段有效曲线基底（段落/情绪全非占位，含反转段） */
function curveOf(...strengths: number[]): PieceList {
  const segments = ['开头钩子', '铺垫', '升级', '反转', '余韵']
  const emotions = ['惊悚', '疑惧', '紧张', '震惊', '后怕']
  return {
    反转线索表: {
      核心反转: 'x',
      铺垫点: [
        { 位置: 'a', 内容: 'x' },
        { 位置: 'b', 内容: 'x' },
        { 位置: 'c', 内容: 'x' },
      ],
    },
    情绪曲线: segments.map((段落, i) => ({ 段落, 情绪: emotions[i]!, 强度: strengths[i]! })),
    伏笔回收: [],
  }
}

test('R30-14: realCurve 混入 NaN 强度 → peak-low 不再漏判（有效峰值 6 < 8 照报）', () => {
  const ids = checkPieceListForm(curveOf(3, 4, 6, NaN, 5)).items.map((i) => i.checkId)
  expect(ids).toContain('emotion-curve-peak-low')
  // 非有限强度仍由既有 emotion-curve-strength 黄项兜底回报（两口径衔接）
  expect(ids).toContain('emotion-curve-strength')
})

test('R30-14: 混入 NaN 但有效峰值 ≥8 → 不误报 peak-low（强度黄项照报）', () => {
  const ids = checkPieceListForm(curveOf(3, 4, 6, 9, NaN)).items.map((i) => i.checkId)
  expect(ids).not.toContain('emotion-curve-peak-low')
  expect(ids).toContain('emotion-curve-strength')
})

test('R30-14: 强度全 NaN → 过滤后空集按 fail-noisy 照报 peak-low', () => {
  const ids = checkPieceListForm(curveOf(NaN, NaN, NaN, NaN, NaN)).items.map((i) => i.checkId)
  expect(ids).toContain('emotion-curve-peak-low')
})
