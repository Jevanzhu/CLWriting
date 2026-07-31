<script setup lang="ts">
// 角色关系图（径向层次 · 主图 + 右侧详情联动）：
// 主角居中，其余角色按 BFS 跳数分环；二环挂在各自父节点的角度扇区内——
// 位置本身即语义（谁是核心、谁因谁而来），且确定性布局每次打开都一致。
// 右侧详情卡跟随选中节点。数据源 #7.5 settings（parseRelations 派生自角色卡「关系」）。
import { ref, computed, onMounted } from 'vue'
import {
  Search, Crosshair, ArrowUpRight, Users,
} from 'lucide-vue-next'
import { getSettings, type CharacterCard, type RelationEdge, type DebtEdge } from '../api/settings'
import { useDocStore } from '../stores/doc'
import { useWorkspaceStore } from '../stores/workspace'
import { useTreeStore } from '../stores/tree'

const props = defineProps<{ bookName: string }>()
const doc = useDocStore()
const ws = useWorkspaceStore()
const tree = useTreeStore()

interface SimNode {
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
interface SimEdge { from: string; to: string; type: string; kind: 'relation' | 'debt' }

// 画布基准（实际可视区由 fitView 按内容包围盒定，节点少时不会空旷）
const W = 820
const H = 560
const CX = W / 2
const CY = H / 2
/** 一环半径基准；每往外一环 +RING_STEP */
const RING_R1 = 168
const RING_STEP = 132
/** 同环相邻节点的最小弧长（防重叠，含胶囊宽 + 间隙） */
const MIN_ARC = 96
/** 子节点挂在父节点角度两侧的扇区宽度 */
const CHILD_SPREAD = Math.PI / 3

const nodes = ref<SimNode[]>([])
const edges = ref<SimEdge[]>([])
const loading = ref(true)
const err = ref<string | null>(null)
const isShort = ref(false)
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
    valid.push({ from: r.from, to: r.to, type: r.type, kind: 'relation' })
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

/** 中心：身份含「主角」优先，其次取度数最大（并列取先出现的）。 */
function pickCenter(ns: SimNode[]): SimNode {
  const heroes = ns.filter((n) => /主角|主人公/.test(n.card?.身份 ?? ''))
  const pool = heroes.length ? heroes : ns
  return pool.reduce((a, b) => (b.degree > a.degree ? b : a))
}

/** 环半径：基准值与「同环节点不重叠」约束取大。 */
function ringRadius(ring: number, count: number): number {
  const base = RING_R1 + (ring - 1) * RING_STEP
  const needed = (count * MIN_ARC) / (2 * Math.PI)
  return Math.max(base, needed)
}

function layoutRadial(): void {
  const ns = nodes.value
  if (!ns.length) return

  // 邻接表
  const adj = new Map<string, string[]>()
  for (const n of ns) adj.set(n.id, [])
  for (const e of edges.value) {
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

  const byRing = new Map<number, SimNode[]>()
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
    const byParent = new Map<string, SimNode[]>()
    for (const n of list) {
      const p = parent.get(n.id) ?? '__orphan__'
      const g = byParent.get(p)
      if (g) g.push(n)
      else byParent.set(p, [n])
    }
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
      const pa = nodes.value.find((x) => x.id === pid)?.angle ?? 0
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
    const r = await getSettings(props.bookName)
    if (r.kind !== 'long') {
      isShort.value = true
      loading.value = false
      return
    }
    isShort.value = false
    buildGraph(r.characters, r.characterRelations, [])
    loading.value = false
  } catch (e) {
    err.value = e instanceof Error ? e.message : String(e)
    loading.value = false
  }
}
onMounted(load)

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
  if (/师|徒|长|父|母|养/.test(t)) return 'var(--cat-4)'
  if (/情|爱|恋|妻|夫|婚/.test(t)) return 'var(--cat-5)'
  if (/兄|弟|姐|妹|友|同/.test(t)) return 'var(--cat-3)'
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

/** 债务边的弓形高度：同一对角色往往既有关系边又有债务边，直线会完全重合。 */
const DEBT_BOW = 26
/** 边几何：关系边走直线，债务边走弧线；顺带给出标签落点。 */
const edgeGeoms = computed(() =>
  edges.value.map((e) => {
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
  }),
)

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
function isDim(id: string): boolean {
  // 搜索时：非匹配项 dim（边保持显示）
  if (searchQuery.value) return !id.toLowerCase().includes(searchQuery.value.toLowerCase())
  // 只有主动 hover 才压暗他人。选中态不压暗——否则一进来默认选中主角，
  // 不与主角相连的关系（苏婉—萧寒、赵长老—血魔）当场消失，全局图先天残缺。
  return hoverId.value !== null && !neighbors.value.has(id)
}
function edgeDim(e: SimEdge): boolean {
  if (searchQuery.value) return false
  const h = hoverId.value
  return h !== null && e.from !== h && e.to !== h
}
/** 高亮 + 显标签：hover 或选中都算（标签只给焦点邻边，避免全图标签打架）。 */
function edgeActive(e: SimEdge): boolean {
  const q = searchQuery.value.trim().toLowerCase()
  // 搜索态下高亮跟着匹配项走，否则会出现「搜 A 却在高亮 B 的边」
  if (q) return e.from.toLowerCase().includes(q) || e.to.toLowerCase().includes(q)
  return focusId.value !== null && (e.from === focusId.value || e.to === focusId.value)
}

// ── 右侧详情卡派生（跟随 selectedId，不随 hover 跳动）──
const selectedNode = computed(() => nodes.value.find((n) => n.id === selectedId.value) ?? null)
const selectedCard = computed(() => selectedNode.value?.card ?? null)
const selectedRelations = computed(() => {
  const id = selectedId.value
  if (!id) return []
  const out: { other: string; type: string; kind: 'relation' | 'debt'; hasCard: boolean }[] = []
  for (const e of edges.value) {
    if (e.from === id) out.push({ other: e.to, type: e.type, kind: e.kind, hasCard: byIdMap.value.get(e.to)?.hasCard ?? false })
    else if (e.to === id) out.push({ other: e.from, type: e.type, kind: e.kind, hasCard: byIdMap.value.get(e.from)?.hasCard ?? false })
  }
  return out
})
function selectNode(id: string): void {
  selectedId.value = id
}

// --- 拖拽 + 点击选中 ---
const svgRef = ref<SVGSVGElement | null>(null)
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
  const pt = svg.createSVGPoint()
  pt.x = evt.clientX
  pt.y = evt.clientY
  const m = svg.getScreenCTM()
  if (!m) return { x: 0, y: 0 }
  const p = pt.matrixTransform(m.inverse())
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
  } catch {
    /* 打开失败忽略（best-effort） */
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

/** 图例只列本图真正出现的语义色，没有的关系类型不占位（债务另有一项，不参与统计）。 */
const LEGEND = [
  { color: 'var(--cat-5)', label: '亲密' },
  { color: 'var(--cat-4)', label: '长辈' },
  { color: 'var(--cat-3)', label: '同辈' },
  { color: 'var(--cat-2)', label: '从属' },
  { color: 'var(--cat-1)', label: '对立' },
] as const
const activeLegend = computed(() => {
  const used = new Set(
    edges.value.filter((e) => e.kind === 'relation').map((e) => edgeColor(e)),
  )
  return LEGEND.filter((l) => used.has(l.color))
})
</script>

<template>
  <div class="rel-scroll">
    <div v-if="loading" class="state-block">载入关系图…</div>
    <div v-else-if="err" class="state-block err">
      关系图载入失败：{{ err }}
      <button class="btn" @click="load">重试</button>
    </div>
    <div v-else-if="isShort" class="state-block">短篇集无角色关系图。</div>
    <div v-else-if="!nodeCount" class="state-block">
      无角色数据。先在「定稿 / 设定 / 角色」建角色卡。
    </div>
    <div v-else class="rel">
      <!-- 顶部工具栏 -->
      <header class="rel-bar">
        <div class="rel-bar-left">
          <h2 class="rel-title">关系网络</h2>
          <span class="rel-count">
            <span class="kc">{{ nodeCount }}</span> 角色
            <span class="sep">·</span>
            <span class="kc">{{ edgeCount }}</span> 关系
            <template v-if="debtCount"><span class="sep">·</span><span class="kc">{{ debtCount }}</span> 债务</template>
          </span>
        </div>
        <div class="rel-bar-right">
          <div class="search-box">
            <Search :size="13" />
            <input v-model="searchQuery" placeholder="搜索角色" />
          </div>
          <button class="tool-btn" data-tip="复位视图与节点" @click="resetView">
            <Crosshair :size="14" /><span>复位</span>
          </button>
        </div>
      </header>

      <!-- 主体：主图 7 : 详情 3 -->
      <div class="rel-body">
        <!-- 左：关系图 -->
        <div class="rel-graph">
          <svg
            ref="svgRef"
            class="graph"
            :viewBox="viewBoxStr"
            preserveAspectRatio="xMidYMid meet"
            @wheel.prevent="onWheel"
            @mousedown="onBgDown"
          >
            <defs>
              <pattern id="rel-dotgrid" width="24" height="24" patternUnits="userSpaceOnUse">
                <circle cx="12" cy="12" r="0.8" class="dot-bg" />
              </pattern>
            </defs>
            <rect x="-9999" y="-9999" width="19998" height="19998" class="bg-rect" />
            <!-- 边：默认就带语义色（弱），聚焦时提到全饱和 -->
            <g class="edges">
              <g v-for="(g, i) in edgeGeoms" :key="i" :class="{ dim: edgeDim(g.e) }">
                <path
                  :d="g.d"
                  class="edge" :class="{ debt: g.e.kind === 'debt', active: edgeActive(g.e) }"
                  :style="{ stroke: edgeColor(g.e) }"
                />
                <text
                  v-if="edgeActive(g.e)"
                  :x="g.mx" :y="g.my"
                  class="edge-label" :style="{ fill: edgeColor(g.e) }"
                  text-anchor="middle" dy="0.32em"
                >{{ g.e.type }}</text>
              </g>
            </g>
            <!-- 节点：胶囊内嵌角色名（名字即节点） -->
            <g class="nodes" :style="{ '--rel-cx': `${CX}px`, '--rel-cy': `${CY}px` }">
              <g
                v-for="n in nodes"
                :key="n.id"
                class="node-g"
                :class="{
                  dim: isDim(n.id), hover: hoverId === n.id, selected: selectedId === n.id,
                  clickable: n.hasCard && !!n.file, center: n.isCenter,
                  'no-card': !n.hasCard, dragging: dragId === n.id,
                }"
                :style="{
                  transform: `translate(${n.x}px, ${n.y}px)`,
                  animationDelay: `${n.ring * 90}ms`,
                  '--nc': nodeColor(n),
                }"
                @mousedown="onNodeDown(n, $event)"
                @dblclick="onNodeDblClick(n)"
                @mouseenter="hoverId = n.id"
                @mouseleave="hoverId = null"
              >
                <!-- 选中态外环（默认透明，hover/选中浮现） -->
                <rect
                  :x="-(nodeW(n) + 10) / 2" :y="-(nodeH(n) + 10) / 2"
                  :width="nodeW(n) + 10" :height="nodeH(n) + 10"
                  :rx="(nodeH(n) + 10) / 2"
                  class="node-halo"
                />
                <!-- 胶囊本体（不透明填充盖住穿过的边线） -->
                <rect
                  :x="-nodeW(n) / 2" :y="-nodeH(n) / 2"
                  :width="nodeW(n)" :height="nodeH(n)"
                  :rx="nodeRx(n)"
                  class="node"
                />
                <text
                  x="0" y="0"
                  class="node-label" :style="{ fontSize: `${nodeFontSize(n)}px` }"
                  text-anchor="middle" dominant-baseline="central"
                >{{ n.id }}</text>
              </g>
            </g>
          </svg>
          <!-- 图例：压成一行 chips，浮在图底部，不再占据竖向空间 -->
          <div class="legend">
            <span v-for="l in activeLegend" :key="l.label" class="lg">
              <i class="lg-line" :style="{ background: l.color }"></i>{{ l.label }}
            </span>
            <span v-if="debtCount" class="lg">
              <i class="lg-line debt" :style="{ color: 'var(--cat-1)' }"></i>债务
            </span>
            <span class="lg"><i class="lg-pill gray"></i>仅被提及</span>
          </div>
        </div>

        <!-- 右：角色详情卡（跟随选中节点） -->
        <aside class="rel-detail">
          <template v-if="selectedNode">
            <div class="dc-head">
              <h3 class="dc-name">{{ selectedNode.id }}</h3>
              <span class="dc-degree">{{ selectedRelations.length }} 条关联</span>
            </div>
            <template v-if="selectedCard">
              <div class="dc-tags">
                <span v-if="selectedCard.境界" class="dc-tag"><span class="dc-tag-k">境界</span>{{ selectedCard.境界 }}</span>
                <span v-if="selectedCard.身份" class="dc-tag"><span class="dc-tag-k">身份</span>{{ selectedCard.身份 }}</span>
              </div>
              <p v-if="selectedCard.目标" class="dc-goal">{{ selectedCard.目标 }}</p>
            </template>
            <div v-else class="dc-nocard">该角色仅被提及，暂无角色卡。</div>

            <div v-if="selectedRelations.length" class="dc-sec">
              <h4 class="dc-sec-h">关系</h4>
              <ul class="dc-rel">
                <li
                  v-for="(r, i) in selectedRelations" :key="i"
                  :class="{ debt: r.kind === 'debt' }"
                  @click="selectNode(r.other)"
                >
                  <span class="dc-rel-name">{{ r.other }}</span>
                  <span class="dc-rel-type" :style="{ color: relColor(r) }">{{ r.type }}</span>
                </li>
              </ul>
            </div>

            <button v-if="selectedNode.hasCard && selectedNode.file" class="dc-open" @click="openCharacter(selectedNode)">
              打开角色卡 <ArrowUpRight :size="13" />
            </button>
          </template>
          <div v-else class="dc-empty">
            <Users :size="28" />
            <p>点选角色节点查看详情</p>
          </div>
        </aside>
      </div>
    </div>
  </div>
</template>

<style scoped>
.rel-scroll {
  height: 100%;
  overflow: auto;
  padding: var(--size-4-5) var(--size-4-6);
}
.rel {
  max-width: 1120px;
  margin: 0 auto;
}

/* ── 顶栏 ── */
.rel-bar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: var(--size-4-3);
  flex-wrap: wrap;
  margin-bottom: var(--size-4-4);
}
.rel-bar-left {
  display: flex;
  align-items: baseline;
  gap: var(--size-4-3);
}
.rel-title {
  margin: 0;
  font-size: var(--font-size-xl);
  font-weight: 700;
  color: var(--text-normal);
}
.rel-count {
  font-size: var(--font-size-s);
  color: var(--text-muted);
}
.rel-count .kc {
  font-weight: 600;
  color: var(--text-normal);
}
.rel-count .sep {
  margin: 0 4px;
  color: var(--text-faint);
}
.rel-bar-right {
  display: flex;
  align-items: center;
  gap: var(--size-4-2);
}
.search-box {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 5px 10px;
  background: var(--interactive-normal);
  border: 1px solid var(--background-modifier-border);
  border-radius: var(--radius-m);
  color: var(--text-faint);
}
.search-box input {
  border: none;
  background: none;
  outline: none;
  font-size: var(--font-size-s);
  color: var(--text-normal);
  width: 96px;
}
.search-box input::placeholder {
  color: var(--text-faint);
}
.tool-btn {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 5px 10px;
  border: 1px solid var(--background-modifier-border);
  border-radius: var(--radius-m);
  background: var(--background-primary);
  color: var(--text-muted);
  font-size: var(--font-size-s);
  cursor: pointer;
  transition: all var(--dur-fast) var(--ease-out);
}
.tool-btn:hover {
  background: var(--background-modifier-hover);
  color: var(--text-normal);
  border-color: var(--background-modifier-border-hover);
}

/* ── 主体双栏 ── */
.rel-body {
  display: grid;
  grid-template-columns: 7fr 3fr;
  gap: var(--size-4-4);
  align-items: start;
}

/* 图区 */
.rel-graph {
  background: var(--background-primary);
  border: 1px solid var(--background-modifier-border);
  border-radius: var(--radius-l);
  padding: var(--size-4-3);
  box-shadow: var(--shadow-s);
}
/* 图例：一行 chips 压在图下方，不再吃掉图区的竖向空间 */
.legend {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--size-4-3);
  padding: var(--size-4-2) 4px 2px;
  border-top: 1px solid var(--background-modifier-border);
  margin-top: var(--size-4-2);
  font-size: var(--font-size-xxs);
  color: var(--text-faint);
}
.lg {
  display: inline-flex;
  align-items: center;
  gap: 5px;
}
.lg-pill {
  display: inline-block;
  border-radius: 99px;
  background: var(--interactive-accent);
}
.lg-pill.gray {
  width: 16px;
  height: 9px;
  background: var(--background-primary);
  border: 1px dashed var(--text-faint);
  opacity: 0.6;
}
.lg-line {
  display: inline-block;
  width: 18px;
  height: 2px;
  border-radius: 1px;
}
/* 债务：虚线，与「对立」同色但线型不同 —— 图例里也得看得出这个区别 */
.lg-line.debt {
  background: none;
  background-image: repeating-linear-gradient(
    to right,
    currentColor 0 4px,
    transparent 4px 7px
  );
}
.graph {
  width: 100%;
  height: auto;
  aspect-ratio: 820 / 560;
  display: block;
  cursor: grab;
}
.graph:active {
  cursor: grabbing;
}

/* SVG 内部 */
.dot-bg {
  fill: var(--text-faint);
  opacity: 0.1;
}
.bg-rect {
  fill: url(#rel-dotgrid);
}
.edge {
  fill: none;
  stroke-width: 1.5;
  /* 默认就上语义色（弱），聚焦时提到全饱和——「灰线一片」是旧版最大的问题 */
  stroke-opacity: 0.32;
  transition: opacity var(--dur-fast) var(--ease-out),
    stroke-opacity var(--dur-fast) var(--ease-out),
    stroke-width var(--dur-fast) var(--ease-out);
}
.edge.active {
  stroke-width: 2.5;
  stroke-opacity: 1;
}
.edge.debt {
  stroke-dasharray: 5 4;
}
.edge-label {
  font-size: var(--font-size-xxs);
  font-weight: 600;
  paint-order: stroke;
  stroke: var(--background-primary);
  stroke-width: 3.5;
  pointer-events: none;
}

/* 节点：--nc 由 inline style 注入（身份语义色），描边式胶囊；中心角色实心 */
.node-g {
  transition: transform var(--dur-slow, 0.34s) var(--ease-out);
  animation: rel-radiate 0.5s var(--ease-out) backwards;
}
.node-g.dragging {
  transition: none;
}
@keyframes rel-radiate {
  from {
    transform: translate(var(--rel-cx), var(--rel-cy)) scale(0.4);
    opacity: 0;
  }
}
.node {
  fill: var(--background-primary);
  stroke: var(--nc);
  stroke-width: 1.5;
  cursor: grab;
  transition: opacity var(--dur-fast) var(--ease-out), fill var(--dur-fast) var(--ease-out);
}
.node-g.center .node {
  fill: var(--nc);
  stroke: none;
}
.node-g.no-card .node {
  fill: none;
  stroke-width: 1;
  stroke-opacity: 0.5;
  stroke-dasharray: 3 3;
}
/* 选中外环：默认透明，仅 hover/选中浮现 */
.node-halo {
  fill: none;
  stroke: transparent;
  stroke-width: 2;
  pointer-events: none;
  transition: stroke var(--dur-fast) var(--ease-out);
}
.node-label {
  fill: var(--nc);
  font-weight: 600;
  pointer-events: none;
  transition: opacity var(--dur-fast) var(--ease-out);
}
.node-g.center .node-label {
  fill: var(--text-on-accent);
  font-weight: 700;
}
.node-g.no-card .node-label {
  fill: var(--text-muted);
}
.dim {
  opacity: 0.28;
}
.node-g.hover .node-halo,
.node-g.selected .node-halo {
  stroke: var(--nc);
}
.node-g.hover .node,
.node-g.selected .node {
  fill: var(--nc);
}
.node-g.hover .node-label,
.node-g.selected .node-label {
  fill: var(--text-on-accent);
}
.node-g.hover.no-card .node,
.node-g.selected.no-card .node {
  fill: var(--background-modifier-hover);
}
.node-g.hover.no-card .node-label,
.node-g.selected.no-card .node-label {
  fill: var(--text-normal);
}
.node-g.clickable {
  cursor: pointer;
}

/* ── 右侧详情卡 ── */
.rel-detail {
  position: sticky;
  top: var(--size-4-5);
  background: var(--background-primary);
  border: 1px solid var(--background-modifier-border);
  border-radius: var(--radius-l);
  padding: var(--size-4-4);
  box-shadow: var(--shadow-s);
}
.dc-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--size-4-2);
  padding: var(--size-4-10) 0;
  color: var(--text-faint);
}
.dc-empty p {
  margin: 0;
  font-size: var(--font-size-s);
}
.dc-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  margin-bottom: var(--size-4-3);
}
.dc-name {
  margin: 0;
  font-size: var(--font-size-xl);
  font-weight: 700;
  color: var(--text-normal);
}
.dc-degree {
  font-size: var(--font-size-xs);
  color: var(--text-faint);
  white-space: nowrap;
}
.dc-tags {
  display: flex;
  flex-wrap: wrap;
  gap: var(--size-4-2);
  margin-bottom: var(--size-4-3);
}
.dc-tag {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 3px 9px;
  background: var(--background-secondary);
  border-radius: var(--radius-s);
  font-size: var(--font-size-xs);
  color: var(--text-normal);
}
.dc-tag-k {
  color: var(--text-faint);
}
.dc-goal {
  margin: 0 0 var(--size-4-3);
  padding: var(--size-4-2) var(--size-4-3);
  background: var(--background-secondary);
  border-radius: var(--radius-s);
  font-size: var(--font-size-s);
  line-height: 1.6;
  color: var(--text-muted);
}
.dc-nocard {
  padding: var(--size-4-2) 0 var(--size-4-3);
  font-size: var(--font-size-s);
  color: var(--text-faint);
}
.dc-sec {
  margin-top: var(--size-4-3);
  padding-top: var(--size-4-3);
  border-top: 1px solid var(--background-modifier-border);
}
.dc-sec-h {
  margin: 0 0 var(--size-4-2);
  font-size: var(--font-size-xxs);
  font-weight: 600;
  color: var(--text-faint);
  text-transform: uppercase;
  letter-spacing: 0.5px;
}
.dc-rel {
  margin: 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 1px;
}
.dc-rel li {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 5px 8px;
  border-radius: var(--radius-s);
  cursor: pointer;
  transition: background var(--dur-fast) var(--ease-out);
}
.dc-rel li:hover {
  background: var(--background-modifier-hover);
}
.dc-rel li.debt .dc-rel-name::before {
  content: '◈ ';
  color: var(--cat-1);
}
.dc-rel-name {
  font-size: var(--font-size-s);
  font-weight: 500;
  color: var(--text-normal);
}
.dc-rel-type {
  font-size: var(--font-size-xs);
}
.dc-open {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  width: 100%;
  margin-top: var(--size-4-4);
  padding: 8px;
  border: 1px solid var(--interactive-accent);
  border-radius: var(--radius-m);
  background: color-mix(in srgb, var(--interactive-accent) 10%, transparent);
  color: var(--text-accent);
  font-size: var(--font-size-s);
  font-weight: 600;
  cursor: pointer;
  transition: all var(--dur-fast) var(--ease-out);
}
.dc-open:hover {
  background: var(--interactive-accent);
  color: var(--text-on-accent);
}

/* ── 状态块 ── */
.state-block {
  padding: var(--size-4-10);
  text-align: center;
  color: var(--text-faint);
  font-size: var(--font-size-m);
}
.state-block.err {
  color: var(--text-error);
}
.btn {
  margin-left: var(--size-4-2);
  padding: 4px 12px;
  font-size: var(--font-size-s);
  border: 1px solid var(--background-modifier-border);
  border-radius: var(--radius-s);
  background: var(--background-primary);
  color: var(--text-normal);
  cursor: pointer;
}
</style>
