/**
 * 关系图共享逻辑（RelationsView 拆分 P2-5）：节点/边状态 + 径向层次布局 + 交互。
 * 壳 RelationsView 调 useRelationGraph(bookName) 并 provide('rel-graph')，
 * RelationGraph / RelationDetail 子组件 inject 获取——避免海量 props 透传。
 *
 * 布局说明：主角居中，其余角色按 BFS 跳数分环；二环挂在各自父节点的角度扇区内——
 * 位置本身即语义（谁是核心、谁因谁而来），且确定性布局每次打开都一致。
 * 数据源 #7.5 settings（parseRelations 派生自角色卡「关系」）。
 */
import { ref, computed, onMounted, onUnmounted, provide, inject, type Ref, type InjectionKey } from 'vue'
import { getSettings, mineRelations, type CharacterCard, type RelationEdge, type DebtEdge } from '../api/settings'
import { getConfig } from '../api/books'
import { useDocStore } from '../stores/doc'
import { useWorkspaceStore } from '../stores/workspace'
import { useTreeStore } from '../stores/tree'
import { useUiStore } from '../stores/ui'
import { usePrefsStore } from '../stores/prefs'
import { friendlyError } from '../shared/error'
import { CX, CY, W, H, computeRadialLayout } from '../shared/relation-layout'

export interface SimNode {
  id: string
  /** 当前位置（拖拽可改） */
  x: number
  y: number
  /** 径向布局算出的原位（双击复位回这里） */
  homeX: number
  homeY: number
  /** 距中心的跳数：0=主角，1=直连，2+=外围，孤立角色排最外环 */
  ring: number
  /** 该节点在环上的角度（弧度），子节点据此挂扇区 */
  angle: number
  degree: number
  isCenter: boolean
  hasCard: boolean
  file?: string
  card?: CharacterCard
}
export interface SimEdge { from: string; to: string; type: string; kind: 'relation' | 'debt'; note?: string }

// 画布基准与布局常量：O-9（第十三轮）移 shared/relation-layout（纯函数层，可单测）；
// CX/CY 转发导出（RelationGraph.vue 消费）
export { CX, CY } from '../shared/relation-layout'

/** 图例只列本图真正出现的语义色，没有的关系类型不占位（债务另有一项，不参与统计）。 */
const LEGEND = [
  { color: 'var(--cat-5)', label: '亲密' },
  { color: 'var(--cat-4)', label: '长辈' },
  { color: 'var(--cat-3)', label: '同辈' },
  { color: 'var(--cat-2)', label: '从属' },
  { color: 'var(--cat-1)', label: '对立' },
] as const

/** 债务边的弓形高度：同一对角色往往既有关系边又有债务边，直线会完全重合。 */
const DEBT_BOW = 26

export interface RelationGraph {
  // 数据
  nodes: Ref<SimNode[]>
  edges: Ref<SimEdge[]>
  loading: Ref<boolean>
  err: Ref<string | null>
  // 筛选
  searchQuery: Ref<string>
  showOrphans: Ref<boolean>
  hiddenColors: Ref<Set<string>>
  visibleNodes: Ref<SimNode[]>
  hiddenCount: Ref<number>
  // 焦点/选中
  hoverId: Ref<string | null>
  selectedId: Ref<string | null>
  dragId: Ref<string | null>
  selectedNode: Ref<SimNode | null>
  selectedCard: Ref<CharacterCard | null>
  selectedRelations: Ref<{ other: string; type: string; kind: 'relation' | 'debt'; hasCard: boolean; note?: string }[]>
  // 派生
  view: Ref<{ x: number; y: number; w: number; h: number }>
  viewBoxStr: Ref<string>
  edgeGeoms: Ref<{ e: SimEdge; d: string; mx: number; my: number }[]>
  nodeCount: Ref<number>
  edgeCount: Ref<number>
  debtCount: Ref<number>
  activeLegend: Ref<Array<(typeof LEGEND)[number]>>
  // 交互
  svgRef: Ref<SVGSVGElement | null>
  bindSvg: (el: unknown) => void
  onWheel: (evt: WheelEvent) => void
  onBgDown: (evt: MouseEvent) => void
  onNodeDown: (node: SimNode, evt: MouseEvent) => void
  onNodeDblClick: (node: SimNode) => void
  resetView: () => void
  selectNode: (id: string) => void
  toggleColor: (color: string) => void
  // 视觉（子组件模板用）
  isDim: (id: string) => boolean
  edgeDim: (e: SimEdge) => boolean
  edgeActive: (e: SimEdge) => boolean
  nodeFontSize: (node: SimNode) => number
  nodeH: (node: SimNode) => number
  nodeW: (node: SimNode) => number
  nodeRx: (node: SimNode) => number
  nodeColor: (node: SimNode) => string
  edgeColor: (e: SimEdge) => string
  relColor: (r: { type: string; kind: 'relation' | 'debt' }) => string
  // 业务
  mining: Ref<boolean>
  onMine: () => Promise<void>
  openCharacter: (n: SimNode) => Promise<void>
  load: () => Promise<void>
}

const KEY: InjectionKey<RelationGraph> = Symbol('rel-graph')

/** 子组件取图实例（必须在 RelationsView 的 provide 作用域内调用） */
export function useRelationGraphInjected(): RelationGraph {
  const g = inject(KEY)
  if (!g) throw new Error('useRelationGraphInjected 必须在 RelationsView 内部使用')
  return g
}

export function useRelationGraph(bookName: string): RelationGraph {
  const doc = useDocStore()
  const ws = useWorkspaceStore()
  const tree = useTreeStore()
  const ui = useUiStore()
  // 关系图自动梳理的全局默认托底（书级未设时生效；ref 初值即硬编码回落，服务端合并同链）
  const prefs = usePrefsStore()

  const nodes = ref<SimNode[]>([])
  const edges = ref<SimEdge[]>([])
  const loading = ref(true)
  const err = ref<string | null>(null)
  const hoverId = ref<string | null>(null)
  const selectedId = ref<string | null>(null)
  const searchQuery = ref('')
  /** viewBox（缩放/平移）：{x,y,w,h} */
  const view = ref({ x: 0, y: 0, w: W, h: H })
  const viewBoxStr = computed(() => `${view.value.x} ${view.value.y} ${view.value.w} ${view.value.h}`)

  function buildGraph(characters: CharacterCard[], rels: RelationEdge[], debts: DebtEdge[]): void {
    const byId = new Map<string, SimNode>()
    const ensure = (id: string, hasCard: boolean, file?: string, card?: CharacterCard): SimNode => {
      let n = byId.get(id)
      if (!n) {
        n = {
          id, x: CX, y: CY, homeX: CX, homeY: CY,
          ring: 0, angle: 0, degree: 0, isCenter: false, hasCard, file, card,
        }
        byId.set(id, n)
      } else if (card && !n.card) {
        n.card = card
        n.hasCard = true
        n.file = file
      }
      return n
    }
    for (const c of characters) {
      if (c.姓名) ensure(c.姓名, true, c.file, c)
    }
    // 角色卡的「关系」是双方各记一遍（林远记恋人苏婉，苏婉也记恋人林远），
    // 直接建边会得到两条完全重合的线：度数翻倍、标签叠画。按无向对去重。
    const valid: SimEdge[] = []
    const seen = new Set<string>()
    const pairKey = (a: string, b: string, kind: string): string =>
      `${a < b ? `${a} ${b}` : `${b} ${a}`} ${kind}`
    for (const r of rels) {
      if (!r.from || !r.to || r.from === r.to) continue
      const k = pairKey(r.from, r.to, 'relation')
      if (seen.has(k)) continue
      seen.add(k)
      valid.push({ from: r.from, to: r.to, type: r.type, kind: 'relation', note: r.note })
      ensure(r.from, byId.has(r.from) ? byId.get(r.from)!.hasCard : false)
      ensure(r.to, byId.has(r.to) ? byId.get(r.to)!.hasCard : false)
    }
    // 债务子图：欠方→债主，弧线虚线（与同一对的关系边错开）；端点可能无角色卡 → 灰节点
    for (const d of debts) {
      if (!d.欠方 || !d.债主 || d.欠方 === d.债主) continue
      const k = pairKey(d.欠方, d.债主, 'debt')
      if (seen.has(k)) continue
      seen.add(k)
      valid.push({ from: d.欠方, to: d.债主, type: d.标题 || '债', kind: 'debt' })
      ensure(d.欠方, byId.has(d.欠方) ? byId.get(d.欠方)!.hasCard : false)
      ensure(d.债主, byId.has(d.债主) ? byId.get(d.债主)!.hasCard : false)
    }
    for (const e of valid) {
      byId.get(e.from)!.degree++
      byId.get(e.to)!.degree++
    }
    nodes.value = [...byId.values()]
    edges.value = valid
    layoutRadial()
    // 默认选中中心角色
    const center = nodes.value.find((n) => n.isCenter)
    if (center) selectedId.value = center.id
  }

  // ── 径向层次布局 ──────────────────────────────
  // 力导向对 5~10 个节点会退化成随机散点，且每次位置都不同；这里改用
  // 确定性的 BFS 分环，位置稳定且直接表达层次。
  // O-9（第十三轮）：算法本体抽 shared/relation-layout.ts 纯函数（可独立单测），
  // 此处只留「数据 → 算法 → 视口贴合」的编排。

  function layoutRadial(): void {
    if (!nodes.value.length) return
    computeRadialLayout(nodes.value, edges.value, edgeTypeOf)
    fitView()
  }

  /** 中心与某节点之间的关系类型（环 1 排序用；无边 → 空串）。 */
  function edgeTypeOf(a: string, b: string): string {
    const e = edges.value.find(
      (x) => (x.from === a && x.to === b) || (x.from === b && x.to === a),
    )
    return e?.type ?? ''
  }

  /** 视口贴合内容包围盒（节点少时不留大片空白）。 */
  function fitView(): void {
    const ns = nodes.value
    if (!ns.length) return
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
    for (const n of ns) {
      const hw = nodeW(n) / 2
      const hh = nodeH(n) / 2
      minX = Math.min(minX, n.homeX - hw)
      maxX = Math.max(maxX, n.homeX + hw)
      minY = Math.min(minY, n.homeY - hh)
      maxY = Math.max(maxY, n.homeY + hh)
    }
    const pad = 48
    const cw = maxX - minX + pad * 2
    const ch = maxY - minY + pad * 2
    // 保持画布宽高比，短边补足
    const ratio = W / H
    let w = cw
    let h = ch
    if (w / h > ratio) h = w / ratio
    else w = h * ratio
    view.value = {
      x: (minX + maxX) / 2 - w / 2,
      y: (minY + maxY) / 2 - h / 2,
      w,
      h,
    }
  }

  async function load(): Promise<void> {
    loading.value = true
    err.value = null
    try {
      const r = await getSettings(bookName)
      buildGraph(r.characters, r.characterRelations, r.debtGraph)
      loading.value = false
      // 自动梳理：章节增量达阈值时触发
      void maybeAutoMine(r.relationCache)
    } catch (e) {
      err.value = friendlyError(e)
      loading.value = false
    }
  }
  onMounted(load)

  // ── AI 关系梳理（读名册/角色卡/正文，AI 提炼关系边）──
  const mining = ref(false)
  /** 显示孤立角色（有卡但零关系边） */
  const showOrphans = ref(false)
  /** 被图例 chip 过滤掉的语义色集合 */
  const hiddenColors = ref<Set<string>>(new Set())
  async function onMine(): Promise<void> {
    if (mining.value) return
    mining.value = true
    err.value = null
    try {
      const r = await mineRelations(bookName, true)
      if (r.ok && r.relations.length) {
        ui.toast(`AI 已梳理 ${r.relations.length} 条关系`, 'success')
        await load()
      } else {
        ui.toast('AI 未梳理到关系（材料不足或产出为空）', 'info')
      }
    } catch (e) {
      // 梳理失败只 toast，不覆盖 err——图主体已渲染成功，页面不应变「载入失败」
      ui.toast(friendlyError(e), 'error')
    } finally {
      mining.value = false
    }
  }

  /** 自动梳理：打开关系图时，若章节增量达阈值则触发。AI 不可用时不触发（避免失败 toast）。 */
  async function maybeAutoMine(cache?: { chapterCount: number | null; currentChapters: number }): Promise<void> {
    if (mining.value || !cache) return
    if (ui.aiAvailable === false) return
    try {
      const cfg = await getConfig(bookName)
      // 自动梳理默认关闭（方案③：手动按钮控成本）；作者开启（书级 ?? 全局默认）后才自动
      if (!(cfg.auto?.relation_auto_mine ?? prefs.relationAutoMine)) return
      const threshold = cfg.auto?.relation_mine_threshold ?? prefs.relationMineThreshold
      const last = cache.chapterCount ?? 0
      if (cache.currentChapters - last < threshold) return
      await onMine()
    } catch {
      /* config 读不到就不自动触发 */
    }
  }

  /** 图例 chip toggle：隐藏/恢复某类语义色的边。 */
  function toggleColor(color: string): void {
    const s = new Set(hiddenColors.value)
    if (s.has(color)) s.delete(color)
    else s.add(color)
    hiddenColors.value = s
  }

  // ── 节点视觉编码 ──────────────────────────────
  // 尺寸三级（主角 > 有卡角色 > 仅被提及），度数不再做连续映射：
  // 十来个节点下连续映射的差异肉眼分辨不出，只会让胶囊参差不齐。

  /** 字号三级。胶囊高宽跟随字号。 */
  function nodeFontSize(node: SimNode): number {
    if (node.isCenter) return 16
    if (!node.hasCard) return 11
    return node.degree >= 3 ? 14 : 13
  }
  /** 胶囊高度 = 字号 + 上下内边距。 */
  function nodeH(node: SimNode): number {
    return nodeFontSize(node) + (node.isCenter ? 18 : 13)
  }
  /** 胶囊宽度 = 字号 × 字数 + 左右内边距（中文字宽约 1em）。 */
  function nodeW(node: SimNode): number {
    return nodeFontSize(node) * Math.max(1, node.id.length) + (node.isCenter ? 32 : 24)
  }
  /** 胶囊圆角 = 半高（全圆胶囊端）。 */
  function nodeRx(node: SimNode): number {
    return nodeH(node) / 2
  }

  /**
   * 语义 → categorical token（色盲安全）。节点身份与边关系共用一套规则，
   * 保证「师父」节点和「师徒」边同色，读图不用来回对照图例。
   */
  function semanticColor(t: string): string {
    if (/敌|仇|恨|魔/.test(t)) return 'var(--cat-1)'
    if (/师|徒|长|父|母|养|亲子/.test(t)) return 'var(--cat-4)'
    if (/情|爱|恋|妻|夫|婚/.test(t)) return 'var(--cat-5)'
    if (/兄|弟|姐|妹|友|同|手足/.test(t)) return 'var(--cat-3)'
    if (/主|仆|属|下|臣/.test(t)) return 'var(--cat-2)'
    return 'var(--text-muted)'
  }
  /** 节点主色：主角=强调色，无卡=灰，其余按身份语义。 */
  function nodeColor(node: SimNode): string {
    if (node.isCenter) return 'var(--interactive-accent)'
    if (!node.hasCard) return 'var(--text-faint)'
    const id = node.card?.身份 ?? ''
    if (/主角|主人公/.test(id)) return 'var(--interactive-accent)'
    return semanticColor(id)
  }

  const byIdMap = computed(() => new Map(nodes.value.map((n) => [n.id, n])))
  function nodeX(id: string): number {
    return byIdMap.value.get(id)?.x ?? CX
  }
  function nodeY(id: string): number {
    return byIdMap.value.get(id)?.y ?? CY
  }

  /** 边几何：关系边走直线，债务边走弧线；顺带给出标签落点。 */
  const edgeGeoms = computed(() => {
    const visIds = new Set(visibleNodes.value.map((n) => n.id))
    return edges.value
      .filter((e) => visIds.has(e.from) && visIds.has(e.to) && !hiddenColors.value.has(edgeColor(e)))
      .map((e) => {
      const x1 = nodeX(e.from)
      const y1 = nodeY(e.from)
      const x2 = nodeX(e.to)
      const y2 = nodeY(e.to)
      if (e.kind !== 'debt') {
        return { e, d: `M${x1},${y1}L${x2},${y2}`, mx: (x1 + x2) / 2, my: (y1 + y2) / 2 }
      }
      const len = Math.max(1, Math.hypot(x2 - x1, y2 - y1))
      // 控制点沿中垂线外推 2×BOW，二次贝塞尔的弧顶恰好落在 1×BOW 处
      const ox = (-(y2 - y1) / len) * DEBT_BOW * 2
      const oy = ((x2 - x1) / len) * DEBT_BOW * 2
      return {
        e,
        d: `M${x1},${y1}Q${(x1 + x2) / 2 + ox},${(y1 + y2) / 2 + oy} ${x2},${y2}`,
        mx: (x1 + x2) / 2 + ox / 2,
        my: (y1 + y2) / 2 + oy / 2,
      }
    })
  })

  // 焦点 = 悬停（临时探索）优先，否则选中（详情卡所指）
  const focusId = computed(() => hoverId.value ?? selectedId.value)
  const neighbors = computed<Set<string>>(() => {
    const h = focusId.value
    if (!h) return new Set()
    const s = new Set<string>([h])
    for (const e of edges.value) {
      if (e.from === h) s.add(e.to)
      if (e.to === h) s.add(e.from)
    }
    return s
  })

  // ── 三层筛选：孤立过滤 → 图例类型过滤 → 搜索聚焦 ──
  /** 搜索匹配节点 + 其一阶邻居（搜索即聚焦到子图） */
  const searchNeighbors = computed<Set<string>>(() => {
    const q = searchQuery.value.trim().toLowerCase()
    if (!q) return new Set()
    const s = new Set<string>()
    for (const n of nodes.value) {
      if (n.id.toLowerCase().includes(q)) {
        s.add(n.id)
        for (const e of edges.value) {
          if (e.from === n.id) s.add(e.to)
          if (e.to === n.id) s.add(e.from)
        }
      }
    }
    return s
  })
  /** 图例过滤后仍可见的边（用于计算有效 degree / 孤立判定） */
  const effectiveEdges = computed(() =>
    edges.value.filter((e) => !hiddenColors.value.has(edgeColor(e))),
  )
  /** 可见节点：默认隐藏孤立（含因图例过滤变孤立的），搜索时只留匹配+邻居 */
  const visibleNodes = computed(() => {
    const visEdgeIds = new Set(effectiveEdges.value.flatMap((e) => [e.from, e.to]))
    let ns = nodes.value
    if (!showOrphans.value) {
      ns = ns.filter((n) => n.isCenter || visEdgeIds.has(n.id))
    }
    if (searchQuery.value.trim()) {
      ns = ns.filter((n) => searchNeighbors.value.has(n.id))
    }
    return ns
  })
  const hiddenCount = computed(() => nodes.value.length - visibleNodes.value.length)

  function isDim(id: string): boolean {
    // 只有主动 hover 才压暗他人。选中态不压暗——否则一进来默认选中主角，
    // 不与主角相连的关系当场消失，全局图先天残缺。
    // 搜索/图例过滤由 visibleNodes 直接隐藏，不再走 dim。
    return hoverId.value !== null && !neighbors.value.has(id)
  }
  function edgeDim(e: SimEdge): boolean {
    const h = hoverId.value
    return h !== null && e.from !== h && e.to !== h
  }
  /** 高亮 + 显标签：hover 或选中都算（标签只给焦点邻边，避免全图标签打架）。 */
  function edgeActive(e: SimEdge): boolean {
    return focusId.value !== null && (e.from === focusId.value || e.to === focusId.value)
  }

  // ── 右侧详情卡派生（跟随 selectedId，不随 hover 跳动）──
  const selectedNode = computed(() => nodes.value.find((n) => n.id === selectedId.value) ?? null)
  const selectedCard = computed(() => selectedNode.value?.card ?? null)
  const selectedRelations = computed(() => {
    const id = selectedId.value
    if (!id) return []
    const out: { other: string; type: string; kind: 'relation' | 'debt'; hasCard: boolean; note?: string }[] = []
    for (const e of edges.value) {
      if (e.from === id) out.push({ other: e.to, type: e.type, kind: e.kind, hasCard: byIdMap.value.get(e.to)?.hasCard ?? false, note: e.note })
      else if (e.to === id) out.push({ other: e.from, type: e.type, kind: e.kind, hasCard: byIdMap.value.get(e.from)?.hasCard ?? false, note: e.note })
    }
    return out
  })
  function selectNode(id: string): void {
    selectedId.value = id
  }

  // --- 拖拽 + 点击选中 ---
  const svgRef = ref<SVGSVGElement | null>(null)
  function bindSvg(el: unknown): void {
    svgRef.value = el as SVGSVGElement | null
  }
  const dragId = ref<string | null>(null)
  let dragNode: SimNode | null = null
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
  function onNodeDown(node: SimNode, evt: MouseEvent): void {
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
    if (n && !dragMoved) selectedId.value = n.id // 未拖动 → 选中（联动右侧详情）
    dragNode = null
    dragId.value = null
    window.removeEventListener('mousemove', onNodeMove)
    window.removeEventListener('mouseup', onNodeUp)
  }
  /** 双击节点：拖歪的节点滑回径向原位。 */
  function onNodeDblClick(node: SimNode): void {
    node.x = node.homeX
    node.y = node.homeY
  }

  /** 打开角色卡 tab（详情卡按钮触发）。无 file / 不在树中 → 忽略。 */
  async function openCharacter(n: SimNode): Promise<void> {
    if (!n.hasCard || !n.file) return
    const node = tree.byPath.get(n.file)
    if (!node || !node.docId) return
    try {
      await doc.open(node)
      ws.openTab(node.docId)
    } catch (e) {
      // P5-前端（第七轮）：静默吞错收敛（对齐 ForeshadowPanel）
      ui.toast(friendlyError(e), 'error')
    }
  }

  // --- 缩放 + 平移 ---
  function onWheel(evt: WheelEvent): void {
    const p = svgPoint(evt)
    const scale = evt.deltaY > 0 ? 1.15 : 1 / 1.15
    const nw = Math.max(W * 0.2, Math.min(W * 4, view.value.w * scale))
    if (nw === view.value.w) return
    const sx = nw / view.value.w
    view.value.x = p.x - (p.x - view.value.x) * sx
    view.value.y = p.y - (p.y - view.value.y) * sx
    view.value.w = nw
    view.value.h = nw / (W / H)
  }
  let panning = false
  let panStart = { x: 0, y: 0, vx: 0, vy: 0 }
  function onBgDown(evt: MouseEvent): void {
    if (evt.button !== 0) return // R72-11（二十轮 E-7）：仅左键平移（右键=菜单、中键=自动滚轮）
    panning = true
    panStart = { x: evt.clientX, y: evt.clientY, vx: view.value.x, vy: view.value.y }
    window.addEventListener('mousemove', onPanMove)
    window.addEventListener('mouseup', onPanUp)
  }
  function onPanMove(evt: MouseEvent): void {
    if (!panning) return
    const svg = svgRef.value
    if (!svg) return
    const rect = svg.getBoundingClientRect()
    const sx = view.value.w / rect.width
    const sy = view.value.h / rect.height
    view.value.x = panStart.vx - (evt.clientX - panStart.x) * sx
    view.value.y = panStart.vy - (evt.clientY - panStart.y) * sy
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
    for (const n of nodes.value) {
      n.x = n.homeX
      n.y = n.homeY
    }
    fitView()
  }

  /** 边色：债务恒用 --cat-1（朱红），靠 .debt 虚线区分线型；其余走语义映射。 */
  function edgeColor(e: SimEdge): string {
    return e.kind === 'debt' ? 'var(--cat-1)' : semanticColor(e.type)
  }
  /** 详情卡关系项颜色（复用 edgeColor 语义） */
  function relColor(r: { type: string; kind: 'relation' | 'debt' }): string {
    return edgeColor({ from: '', to: '', type: r.type, kind: r.kind })
  }

  const nodeCount = computed(() => nodes.value.length)
  const edgeCount = computed(() => edges.value.filter((e) => e.kind === 'relation').length)
  const debtCount = computed(() => edges.value.filter((e) => e.kind === 'debt').length)

  /** 图例只列本图真正出现的语义色（activeLegend 过滤） */
  const activeLegend = computed(() => {
    const used = new Set(
      edges.value.filter((e) => e.kind === 'relation').map((e) => edgeColor(e)),
    )
    return LEGEND.filter((l) => used.has(l.color))
  })

  const graph: RelationGraph = {
    nodes, edges, loading, err,
    searchQuery, showOrphans, hiddenColors, visibleNodes, hiddenCount,
    hoverId, selectedId, dragId, selectedNode, selectedCard, selectedRelations,
    view, viewBoxStr, edgeGeoms, nodeCount, edgeCount, debtCount, activeLegend,
    svgRef, bindSvg, onWheel, onBgDown, onNodeDown, onNodeDblClick, resetView, selectNode, toggleColor,
    isDim, edgeDim, edgeActive, nodeFontSize, nodeH, nodeW, nodeRx, nodeColor, edgeColor, relColor,
    mining, onMine, openCharacter, load,
  }
  provide(KEY, graph)
  return graph
}
