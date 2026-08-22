/**
 * 关系图径向层次布局（O-9（第十三轮）自 useRelationGraph 抽出的纯函数）。
 *
 * 确定性 BFS 分环：主角居中，其余角色按跳数分环；二环起挂在各自父节点的角度
 * 扇区内——位置本身即语义（谁是核心、谁因谁而来），且确定性布局每次打开都一致。
 * 纯函数（无 Vue/DOM 依赖、同输入同输出原地赋值），可独立单测。
 */

// 画布基准（实际可视区由 fitView 按内容包围盒定，节点少时不会空旷）
export const W = 820
export const H = 560
/** 中心坐标（节点入场动画的放射起点） */
export const CX = W / 2
export const CY = H / 2
/** 一环半径基准；每往外一环 +RING_STEP */
export const RING_R1 = 168
export const RING_STEP = 132
/** 同环相邻节点的最小弧长（防重叠，含胶囊宽 + 间隙） */
export const MIN_ARC = 96
/** 子节点挂在父节点角度两侧的扇区宽度 */
export const CHILD_SPREAD = Math.PI / 3

/** 布局所需的最小节点形状（useRelationGraph 的 SimNode 结构满足；身份用于选中心）。 */
export interface RadialLayoutNode {
  id: string
  x: number
  y: number
  homeX: number
  homeY: number
  ring: number
  angle: number
  degree: number
  isCenter: boolean
  card?: { 身份?: string } | null
}

export interface RadialLayoutEdge {
  from: string
  to: string
}

/** 中心：身份含「主角」优先，其次取度数最大（并列取先出现的）。 */
export function pickCenter(ns: RadialLayoutNode[]): RadialLayoutNode {
  const heroes = ns.filter((n) => /主角|主人公/.test(n.card?.身份 ?? ''))
  const pool = heroes.length ? heroes : ns
  return pool.reduce((a, b) => (b.degree > a.degree ? b : a))
}

/** 环半径：基准值与「同环节点不重叠」约束取大。 */
export function ringRadius(ring: number, count: number): number {
  const base = RING_R1 + (ring - 1) * RING_STEP
  const needed = (count * MIN_ARC) / (2 * Math.PI)
  return Math.max(base, needed)
}

/**
 * 径向层次布局（原地赋值 x/y/homeX/homeY/ring/angle/isCenter）。
 * @param edgeTypeOf 两节点间的关系类型（环 1 排序聚簇用；无边 → 空串）
 */
export function computeRadialLayout(
  ns: RadialLayoutNode[],
  edges: RadialLayoutEdge[],
  edgeTypeOf: (a: string, b: string) => string,
): void {
  if (!ns.length) return

  // 邻接表
  const adj = new Map<string, string[]>()
  for (const n of ns) adj.set(n.id, [])
  for (const e of edges) {
    adj.get(e.from)?.push(e.to)
    adj.get(e.to)?.push(e.from)
  }

  // BFS 分环 + 记父（父决定子挂在哪个扇区）
  const center = pickCenter(ns)
  for (const n of ns) n.isCenter = n === center
  const ring = new Map<string, number>([[center.id, 0]])
  const parent = new Map<string, string>()
  const queue: string[] = [center.id]
  while (queue.length) {
    const cur = queue.shift()!
    for (const nb of adj.get(cur) ?? []) {
      if (ring.has(nb)) continue
      ring.set(nb, ring.get(cur)! + 1)
      parent.set(nb, cur)
      queue.push(nb)
    }
  }
  // 孤立角色（有卡但无任何关系）→ 最外环
  const reachedMax = Math.max(0, ...ring.values())
  const orphanRing = reachedMax + 1
  for (const n of ns) if (!ring.has(n.id)) ring.set(n.id, orphanRing)

  const byRing = new Map<number, RadialLayoutNode[]>()
  for (const n of ns) {
    n.ring = ring.get(n.id)!
    const list = byRing.get(n.ring)
    if (list) list.push(n)
    else byRing.set(n.ring, [n])
  }

  // 环 0：中心
  center.angle = 0
  center.homeX = CX
  center.homeY = CY

  // 环 1：均分整圈，起点正上方；同关系类型相邻 → 视觉自然成簇
  const r1 = byRing.get(1) ?? []
  r1.sort((a, b) => edgeTypeOf(center.id, a.id).localeCompare(edgeTypeOf(center.id, b.id), 'zh-Hans-CN'))
  const rad1 = ringRadius(1, r1.length)
  r1.forEach((n, i) => {
    n.angle = -Math.PI / 2 + (i / r1.length) * Math.PI * 2
    n.homeX = CX + rad1 * Math.cos(n.angle)
    n.homeY = CY + rad1 * Math.sin(n.angle)
  })

  // 环 2+：挂在各自父节点的角度扇区内（血魔落在赵长老外侧）
  const maxRing = Math.max(...byRing.keys())
  for (let r = 2; r <= maxRing; r++) {
    const list = byRing.get(r) ?? []
    if (!list.length) continue
    const rad = ringRadius(r, list.length)
    const byParent = new Map<string, RadialLayoutNode[]>()
    for (const n of list) {
      const p = parent.get(n.id) ?? '__orphan__'
      const g = byParent.get(p)
      if (g) g.push(n)
      else byParent.set(p, [n])
    }
    const nodeById = new Map(ns.map((n) => [n.id, n] as const))
    for (const [pid, kids] of byParent) {
      if (pid === '__orphan__') {
        // 无父（孤立角色）：本环内均分
        kids.forEach((n, i) => {
          n.angle = -Math.PI / 2 + (i / kids.length) * Math.PI * 2
          n.homeX = CX + rad * Math.cos(n.angle)
          n.homeY = CY + rad * Math.sin(n.angle)
        })
        continue
      }
      const pa = nodeById.get(pid)?.angle ?? 0
      kids.forEach((n, i) => {
        n.angle = kids.length === 1
          ? pa
          : pa - CHILD_SPREAD / 2 + (i / (kids.length - 1)) * CHILD_SPREAD
        n.homeX = CX + rad * Math.cos(n.angle)
        n.homeY = CY + rad * Math.sin(n.angle)
      })
    }
  }

  // home* 是布局原位，x/y 是渲染位（拖拽后会偏离）——布局完成时两者对齐
  for (const n of ns) {
    n.x = n.homeX
    n.y = n.homeY
  }
}
