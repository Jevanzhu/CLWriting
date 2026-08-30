/**
 * O-9（第十三轮）：关系图径向层次布局纯函数单测——自 useRelationGraph 抽出后
 * 锁行为：主角居中、BFS 分环、二环挂父扇区、孤立角色最外环、确定性（同输入同输出）。
 */
import { describe, it, expect } from 'vitest'
import { computeRadialLayout, pickCenter, ringRadius, CX, CY, RING_R1, MIN_ARC, type RadialLayoutNode } from '../../../src/studio/web-next/src/shared/relation-layout'

function mkNode(id: string, degree: number, 身份?: string): RadialLayoutNode {
  return { id, x: 0, y: 0, homeX: 0, homeY: 0, ring: -1, angle: 0, degree, isCenter: false, card: 身份 ? { 身份 } : undefined }
}

describe('O-9 relation-layout', () => {
  it('pickCenter：身份含「主角」优先；无主角取度数最大（并列取先出现）', () => {
    const hero = mkNode('hero', 1, '主角')
    const strong = mkNode('strong', 9)
    const strong2 = mkNode('strong2', 9)
    expect(pickCenter([strong, hero, strong2])).toBe(hero)
    expect(pickCenter([strong, strong2])).toBe(strong)
  })

  it('ringRadius：基准值与防重叠约束取大', () => {
    expect(ringRadius(1, 3)).toBe(RING_R1) // 3 块不挤：取基准
    const many = Math.ceil((2 * Math.PI * RING_R1) / MIN_ARC) + 5
    expect(ringRadius(1, many)).toBeGreaterThan(RING_R1)
  })

  it('布局：主角居中（环 0），直连环 1，隔一跳环 2；home 与渲染位对齐', () => {
    const a = mkNode('主角', 3, '主角')
    const b = mkNode('直连B', 1)
    const c = mkNode('隔一跳C', 1)
    const ns = [a, b, c]
    computeRadialLayout(ns, [
      { from: '主角', to: '直连B' },
      { from: '直连B', to: '隔一跳C' },
    ], () => '同辈')
    expect(a.isCenter).toBe(true)
    expect(a.ring).toBe(0)
    expect(a.homeX).toBe(CX)
    expect(a.homeY).toBe(CY)
    expect(b.ring).toBe(1)
    expect(c.ring).toBe(2)
    for (const n of ns) {
      expect(n.x).toBe(n.homeX) // 布局完成时渲染位 = 原位
      expect(n.y).toBe(n.homeY)
    }
  })

  it('二环扇区：单子节点继承父角度；双子节点落在父角 ±CHILD_SPREAD/2 内', () => {
    const a = mkNode('主角', 3, '主角')
    const b = mkNode('父', 1)
    const c1 = mkNode('子1', 0)
    const c2 = mkNode('子2', 0)
    computeRadialLayout([a, b, c1, c2], [
      { from: '主角', to: '父' },
      { from: '父', to: '子1' },
      { from: '父', to: '子2' },
    ], () => '同辈')
    expect(b.ring).toBe(1)
    expect(c1.ring).toBe(2)
    expect(c2.ring).toBe(2)
    // 双子关于父角度对称（角度差为扇区宽）
    const spread = Math.abs(c1.angle - c2.angle)
    expect(spread).toBeCloseTo(Math.PI / 3, 5)
    // 两个子角度都在父角度两侧
    expect(Math.min(c1.angle, c2.angle)).toBeLessThanOrEqual(b.angle)
    expect(Math.max(c1.angle, c2.angle)).toBeGreaterThanOrEqual(b.angle)
  })

  it('孤立角色（有卡无关系）排最外环；空节点集不抛', () => {
    const a = mkNode('主角', 1, '主角')
    const lone = mkNode('孤岛', 0)
    computeRadialLayout([a, lone], [], () => '')
    expect(a.ring).toBe(0)
    expect(lone.ring).toBe(1) // 孤儿环 = 最大可达环 + 1
    expect(() => computeRadialLayout([], [], () => '')).not.toThrow()
  })

  it('确定性：同输入两次布局结果逐字段一致', () => {
    const mk = () => [
      mkNode('主角', 2, '主角'),
      mkNode('甲', 1),
      mkNode('乙', 1),
      mkNode('丙', 0),
    ]
    const edges = [
      { from: '主角', to: '甲' },
      { from: '甲', to: '乙' },
    ]
    const n1 = mk(); const n2 = mk()
    computeRadialLayout(n1, edges, (a, _b) => (a === '主角' ? '同辈' : ''))
    computeRadialLayout(n2, edges, (a, _b) => (a === '主角' ? '同辈' : ''))
    for (let i = 0; i < n1.length; i++) {
      expect(n1[i]!.homeX).toBe(n2[i]!.homeX)
      expect(n1[i]!.homeY).toBe(n2[i]!.homeY)
      expect(n1[i]!.ring).toBe(n2[i]!.ring)
      expect(n1[i]!.angle).toBe(n2[i]!.angle)
    }
  })
})
