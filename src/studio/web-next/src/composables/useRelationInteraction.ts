/**
 * 关系图交互（自 useRelationGraph 抽出）：画布坐标映射 + 节点拖拽 / 空白平移 /
 * 滚轮缩放 / 视图复位，含 window mousemove/mouseup 监听的登记与卸载（mouseup 正常
 * 清理 + 组件卸载兜底）。
 *
 * 与两侧的分工——`shared/relation-layout` 纯计算（BFS 分环，无 Vue/DOM，可独立单测）；
 * 本件只做交互，数据面经 deps 注入（节点读数 / 视口 / 选中 / 视口贴合）；数据装载、
 * 布局编排、派生与视觉编码仍归 useRelationGraph，由它把数据面与本件装配成对外关系图
 * 对象——对外形态与拆分前逐位一致（RelationsView 的 provide 与子组件 inject 零改动）。
 */
import { ref, onUnmounted, type Ref } from 'vue'
import { W, H } from '../shared/relation-layout'

/** 交互面所需的最小节点形状（useRelationGraph 的 SimNode 结构满足；只辨别位与原位） */
export interface InteractionNode {
  id: string
  x: number
  y: number
  /** 径向布局算出的原位（双击复位回这里） */
  homeX: number
  homeY: number
}

/** 视口矩形（缩放/平移的唯一载体） */
export interface InteractionView {
  x: number
  y: number
  w: number
  h: number
}

export interface RelationInteractionDeps {
  /** 节点读数口（函数形式：Ref 的 getter/setter 双型在赋值面是逆变的，
   *  函数返回口天然协变——数据面传 SimNode[] 不必收窄） */
  readNodes: () => InteractionNode[]
  view: Ref<InteractionView>
  selectedId: Ref<string | null>
  /** 视口贴合内容包围盒（数据面提供；与 resetView 共用同一出口，防两处口径分叉） */
  fitView: () => void
}

export interface RelationInteraction {
  svgRef: Ref<SVGSVGElement | null>
  bindSvg: (el: unknown) => void
  dragId: Ref<string | null>
  onWheel: (evt: WheelEvent) => void
  onBgDown: (evt: MouseEvent) => void
  onNodeDown: (node: InteractionNode, evt: MouseEvent) => void
  onNodeDblClick: (node: InteractionNode) => void
  resetView: () => void
}

/** 滚轮 deltaY → 缩放倍率（mac适配，导出纯函数便于单测）。
 *  幅值归一 exp(-deltaY*k)：离散滚轮一格 deltaY≈±100 → ≈1.22 倍（与旧固定步进 1.15
 *  观感接近）；mac 触控板高频小 delta 连发改为平滑缩放，不再一步撞缩放钳制；
 *  捏合手势（ctrlKey 且小 delta）同式自然成立。deltaY 向下滚为正 → 倍率 <1 缩小。 */
export function wheelScale(deltaY: number): number {
  return Math.exp(-deltaY * 0.002)
}

export function useRelationInteraction(deps: RelationInteractionDeps): RelationInteraction {
  // --- 拖拽 + 点击选中 ---
  const svgRef = ref<SVGSVGElement | null>(null)
  function bindSvg(el: unknown): void {
    svgRef.value = el as SVGSVGElement | null
  }
  const dragId = ref<string | null>(null)
  let dragNode: InteractionNode | null = null
  let dragOffX = 0
  let dragOffY = 0
  let dragMoved = false
  let downX = 0
  let downY = 0

  function svgPoint(evt: { clientX: number; clientY: number }): { x: number; y: number } {
    const svg = svgRef.value
    if (!svg) return { x: 0, y: 0 }
    const m = svg.getScreenCTM()
    if (!m) return { x: 0, y: 0 }
    const p = new DOMPoint(evt.clientX, evt.clientY).matrixTransform(m.inverse())
    return { x: p.x, y: p.y }
  }
  function onNodeDown(node: InteractionNode, evt: MouseEvent): void {
    evt.preventDefault()
    evt.stopPropagation()
    dragNode = node
    dragId.value = node.id
    dragMoved = false
    downX = evt.clientX
    downY = evt.clientY
    const p = svgPoint(evt)
    dragOffX = p.x - node.x
    dragOffY = p.y - node.y
    window.addEventListener('mousemove', onNodeMove)
    window.addEventListener('mouseup', onNodeUp)
  }
  function onNodeMove(evt: MouseEvent): void {
    if (!dragNode) return
    if (!dragMoved) {
      const dx = evt.clientX - downX
      const dy = evt.clientY - downY
      if (dx * dx + dy * dy < 16) return
      dragMoved = true
    }
    const p = svgPoint(evt)
    dragNode.x = p.x - dragOffX
    dragNode.y = p.y - dragOffY
  }
  function onNodeUp(): void {
    const n = dragNode
    if (n && !dragMoved) deps.selectedId.value = n.id // 未拖动 → 选中（联动右侧详情）
    dragNode = null
    dragId.value = null
    window.removeEventListener('mousemove', onNodeMove)
    window.removeEventListener('mouseup', onNodeUp)
  }
  /** 双击节点：拖歪的节点滑回径向原位。 */
  function onNodeDblClick(node: InteractionNode): void {
    node.x = node.homeX
    node.y = node.homeY
  }

  // --- 缩放 + 平移 ---
  function onWheel(evt: WheelEvent): void {
    const p = svgPoint(evt)
    // mac适配：固定步进（>0 ? 1.15 : 1/1.15）在触控板高频小 delta 下
    // 连发数十事件瞬间撞钳制——改 wheelScale 幅值归一（换算见函数头注）；钳制不动
    const scale = wheelScale(evt.deltaY)
    const nw = Math.max(W * 0.2, Math.min(W * 4, deps.view.value.w * scale))
    if (nw === deps.view.value.w) return
    const sx = nw / deps.view.value.w
    deps.view.value.x = p.x - (p.x - deps.view.value.x) * sx
    deps.view.value.y = p.y - (p.y - deps.view.value.y) * sx
    deps.view.value.w = nw
    deps.view.value.h = nw / (W / H)
  }
  let panning = false
  let panStart = { x: 0, y: 0, vx: 0, vy: 0 }
  function onBgDown(evt: MouseEvent): void {
    if (evt.button !== 0) return // 仅左键平移（右键=菜单、中键=自动滚轮）
    panning = true
    panStart = { x: evt.clientX, y: evt.clientY, vx: deps.view.value.x, vy: deps.view.value.y }
    window.addEventListener('mousemove', onPanMove)
    window.addEventListener('mouseup', onPanUp)
  }
  function onPanMove(evt: MouseEvent): void {
    if (!panning) return
    const svg = svgRef.value
    if (!svg) return
    const rect = svg.getBoundingClientRect()
    const sx = deps.view.value.w / rect.width
    const sy = deps.view.value.h / rect.height
    deps.view.value.x = panStart.vx - (evt.clientX - panStart.x) * sx
    deps.view.value.y = panStart.vy - (evt.clientY - panStart.y) * sy
  }
  function onPanUp(): void {
    panning = false
    window.removeEventListener('mousemove', onPanMove)
    window.removeEventListener('mouseup', onPanUp)
  }
  // 兜底：拖拽中切 view/卸载时移除残留 window 监听（正常由 onNodeUp/onPanUp 在 mouseup 清理）
  onUnmounted(() => {
    window.removeEventListener('mousemove', onNodeMove)
    window.removeEventListener('mouseup', onNodeUp)
    window.removeEventListener('mousemove', onPanMove)
    window.removeEventListener('mouseup', onPanUp)
  })
  function resetView(): void {
    // 视图回到贴合内容，同时把拖歪的节点全部收回原位
    for (const n of deps.readNodes()) {
      n.x = n.homeX
      n.y = n.homeY
    }
    deps.fitView()
  }

  return { svgRef, bindSvg, dragId, onWheel, onBgDown, onNodeDown, onNodeDblClick, resetView }
}
