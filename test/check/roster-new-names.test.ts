/**
 * 新专名候选（checkNewNames）的正确性契约：判重精确全等 + 混排行伪专名守卫。
 *
 * 档源（4 档并 1，按被测行为合并；断言逐条保留、去重 0 条）：
 * - r30-roster-manifest.test.ts 的 R30-2 组（同文件 R30-14 情绪曲线 NaN 组属
 *   checkPieceListForm 家族，并入 short-checks.test.ts）
 * - r29-check-machine-correctness.test.ts 的 B-12 组
 * - r76-machine-checks.test.ts 的 R76-3 组
 * - r0912-check-fix-batch.test.ts 的 R0912-F-P3-2 组
 *
 * 行为契约：判重由「名册全文 includes」改「已登记名字集合精确全等」（parseRosterNames
 * 局部单源，R30-2）——长名包含候选（「林晚晴」⊃「林晚」）不再误判已登记；Set 化后
 * 精确全等语义不变（R0912-F-P3-2）；动作+无句读短引语的混排行不再产伪专名黄项
 *（R76-3 句读守卫改在剥句读前的原文上判 / B-12 引导词紧邻窗口 span 豁免）。
 */
import { describe, it, expect } from 'vitest'
import { rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdtempTracked } from '../helpers/temp-dir.js'
import { checkNewNames } from '../../src/check/count.js'

// ── R30-2：名册精确判重 ──────────────────────────────────────────

describe('名册精确判重（长名不吞短名）', () => {
  it('R30-2: 名册含「林晚晴」时候选「林晚」仍报新专名（长名不再吞短名）', () => {
    const dir = mkdtempTracked(join(tmpdir(), 'roster-new-names-'))
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

  it('R30-2: 「林晚晴」本身已登记不报；括注不污染精确名', () => {
    const dir = mkdtempTracked(join(tmpdir(), 'roster-new-names-'))
    try {
      const roster = join(dir, '名册.md')
      writeFileSync(roster, '# 名册\n- 已登记：林晚晴（女主）\n', 'utf-8')
      const r = checkNewNames('「林晚晴」握紧了剑。', roster)
      expect(r.items).toHaveLength(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('R30-2: 名册缺失 → 空结果路径不回归（不崩、零项）', () => {
    const r = checkNewNames('「林晚」握紧了剑。', join(tmpdir(), '不存在-' + Date.now() + '.md'))
    expect(r.items).toHaveLength(0)
  })

  it('R0912-F-P3-2: 名册 Set 化后精确全等判重语义不变（长名不吞短名）', () => {
    const dir = mkdtempTracked(join(tmpdir(), 'roster-new-names-'))
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
})

// ── B-12 / R76-3：混排行伪专名守卫 ───────────────────────────────

/** 空名册（候选全部上报）的小工具 */
function candidatesOf(body: string): string[] {
  const dir = mkdtempTracked(join(tmpdir(), 'roster-new-names-'))
  try {
    const roster = join(dir, '名册.md')
    writeFileSync(roster, '空名册', 'utf-8')
    return checkNewNames(body, roster).items.map((i) => i.message.match(/「(.+?)」/)?.[1] ?? '')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe('混排行伪专名守卫', () => {
  it('B-12: 动作+无句读短引语的混排行不再产伪专名黄项', () => {
    // 引导词紧邻（隔一个冒号也算紧邻）→ span 判为对白引用跳过（修复前「别动」报伪专名）
    expect(candidatesOf('他低声道：「别动」，然后按住她的肩。')).toEqual([])
    expect(candidatesOf('林晚喊道「站住」，追了出去。')).toEqual([])
  })

  it('B-12: 引导词不在紧邻窗口 / 词表外 / 引号外 → 真候选照报', () => {
    // 引导词不在紧邻窗口（中间隔了「了很多」）→ 「诚实」照报
    expect(candidatesOf('他说了很多，「诚实」才是关键。')).toContain('诚实')
    // 词表外引导（「名叫」的「叫」不是说话动词）→ 真专名不误杀
    expect(candidatesOf('名叫「萧破军」的人影闪进巷子。')).toContain('萧破军')
    // 同行混合：对白 span 豁免，引号外真提及（另一 span、无引导词）照报
    expect(candidatesOf('林晚喊道「站住」，远处「萧破军」的杀声逼近。')).toEqual(['萧破军'])
  })

  it('R76-3: 动作+对白混排行的引语段不再报伪专名；真新名照报', () => {
    // 报告 tsx 实测复现的两条穿透样例（原判的是已被 punctRe 剥净的 name，恒 false）
    expect(candidatesOf('他低声道：「别动。」然后按住她的肩。\n')).toEqual([])
    expect(candidatesOf('她喊着「快走，掩护」头也不回地冲了出去。\n')).toEqual([])
    // 阳性对照：无句读的真新名仍报
    expect(candidatesOf('他们口中的「玄天宗」势力庞大。\n')).toContain('玄天宗')
  })
})
