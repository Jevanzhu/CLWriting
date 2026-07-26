<script setup lang="ts">
// 角色关系图（块5 D1）：GET /settings → 节点(characters)+边(characterRelations)
// 力导向布局（斥力+引力+中心引力+阻尼）→ SVG 渲染 → 悬停高亮邻边 + 拖拽节点。
// 纯 SVG 无图表库；数据源 #7.5 settings 端点（parseRelations 派生自角色卡「关系」字段）。
import { ref, computed, onMounted, onUnmounted } from 'vue'
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
  x: number
  y: number
  vx: number
  vy: number
  degree: number
  hasCard: boolean
  file?: string
  fixed: boolean
}
interface SimEdge { from: string; to: string; type: string; kind: 'relation' | 'debt' }

// 画布 + 物理参数（经验初值，手感调）
const W = 820
const H = 560
const CX = W / 2
const CY = H / 2
// 斥力 / 连线长度随节点数自适应（buildGraph 末尾 tune），防密集塌缩 / 稀疏过散
let REPULSION = 6000
const ATTRACTION = 0.03
let IDEAL_LEN = 130
const CENTER_GRAVITY = 0.015
const DAMPING = 0.82

const nodes = ref<SimNode[]>([])
const edges = ref<SimEdge[]>([])
const loading = ref(true)
const err = ref<string | null>(null)
const isShort = ref(false)
const hoverId = ref<string | null>(null)
/** viewBox（D2 缩放/平移）：{x,y,w,h} */
const view = ref({ x: 0, y: 0, w: W, h: H })
const viewBoxStr = computed(() => `${view.value.x} ${view.value.y} ${view.value.w} ${view.value.h}`)

let rafId = 0
let running = false

function buildGraph(characters: CharacterCard[], rels: RelationEdge[], debts: DebtEdge[]): void {
  const byId = new Map<string, SimNode>()
  const ensure = (id: string, hasCard: boolean, file?: string): SimNode => {
    let n = byId.get(id)
    if (!n) {
      n = { id, x: 0, y: 0, vx: 0, vy: 0, degree: 0, hasCard, file, fixed: false }
      byId.set(id, n)
    }
    return n
  }
  for (const c of characters) {
    if (c.姓名) ensure(c.姓名, true, c.file)
  }
  const valid: SimEdge[] = []
  for (const r of rels) {
    if (!r.from || !r.to || r.from === r.to) continue
    valid.push({ from: r.from, to: r.to, type: r.type, kind: 'relation' })
    ensure(r.from, byId.has(r.from) ? byId.get(r.from)!.hasCard : false)
    ensure(r.to, byId.has(r.to) ? byId.get(r.to)!.hasCard : false)
  }
  // 债务子图（D2）：欠方→债主，虚线边；端点可能无角色卡 → 灰节点
  for (const d of debts) {
    if (!d.欠方 || !d.债主 || d.欠方 === d.债主) continue
    valid.push({ from: d.欠方, to: d.债主, type: d.标题 || '债', kind: 'debt' })
    ensure(d.欠方, byId.has(d.欠方) ? byId.get(d.欠方)!.hasCard : false)
    ensure(d.债主, byId.has(d.债主) ? byId.get(d.债主)!.hasCard : false)
  }
  for (const e of valid) {
    byId.get(e.from)!.degree++
    byId.get(e.to)!.degree++
  }
  // 初始圆周分布 + 微扰
  const ns = [...byId.values()]
  const R = Math.min(W, H) * 0.32
  ns.forEach((n, i) => {
    const a = (i / ns.length) * Math.PI * 2
    n.x = CX + R * Math.cos(a) + (Math.random() - 0.5) * 24
    n.y = CY + R * Math.sin(a) + (Math.random() - 0.5) * 24
  })
  // 力导向参数自适应节点数：密集（N 大）→ 增斥力 + 缩连线距防塌缩；稀疏（N 小）→ 反之
  const N = ns.length
  REPULSION = 6000 * Math.max(0.6, Math.min(2.5, N / 12))
  IDEAL_LEN = 130 * Math.max(0.55, Math.min(1.1, 12 / Math.max(1, N)))
  nodes.value = ns
  edges.value = valid
}

function step(): void {
  const ns = nodes.value
  const n = ns.length
  // 斥力（节点对）
  for (let i = 0; i < n; i++) {
    const a = ns[i]!
    for (let j = i + 1; j < n; j++) {
      const b = ns[j]!
      let dx = b.x - a.x
      let dy = b.y - a.y
      let d2 = dx * dx + dy * dy
      if (d2 < 1) {
        d2 = 1
        dx = Math.random() - 0.5
        dy = Math.random() - 0.5
      }
      const d = Math.sqrt(d2)
      const f = REPULSION / d2
      const fx = (f * dx) / d
      const fy = (f * dy) / d
      a.vx -= fx
      a.vy -= fy
      b.vx += fx
      b.vy += fy
    }
  }
  // 引力（边）
  const byId = new Map(ns.map((node) => [node.id, node]))
  for (const e of edges.value) {
    const a = byId.get(e.from)!
    const b = byId.get(e.to)!
    const dx = b.x - a.x
    const dy = b.y - a.y
    const d = Math.max(1, Math.sqrt(dx * dx + dy * dy))
    const f = (d - IDEAL_LEN) * ATTRACTION
    const fx = (f * dx) / d
    const fy = (f * dy) / d
    a.vx += fx
    a.vy += fy
    b.vx -= fx
    b.vy -= fy
  }
  // 中心引力 + 阻尼 + 更新
  let maxV = 0
  for (const node of ns) {
    node.vx += (CX - node.x) * CENTER_GRAVITY
    node.vy += (CY - node.y) * CENTER_GRAVITY
    node.vx *= DAMPING
    node.vy *= DAMPING
    if (!node.fixed) {
      node.x += node.vx
      node.y += node.vy
    }
    const v = Math.abs(node.vx) + Math.abs(node.vy)
    if (v > maxV) maxV = v
  }
  if (maxV < 0.3) stop()
}

function start(): void {
  if (running) return
  running = true
  let frames = 0
  const loop = (): void => {
    step()
    frames++
    if (frames > 500) {
      stop()
      return
    }
    if (running) rafId = requestAnimationFrame(loop)
  }
  rafId = requestAnimationFrame(loop)
}
function stop(): void {
  running = false
  if (rafId) cancelAnimationFrame(rafId)
  rafId = 0
}
function kick(): void {
  for (const node of nodes.value) {
    node.vx += (Math.random() - 0.5) * 2
    node.vy += (Math.random() - 0.5) * 2
  }
  start()
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
    buildGraph(r.characters, r.characterRelations, r.debtGraph ?? [])
    loading.value = false
    if (nodes.value.length) start()
  } catch (e) {
    err.value = e instanceof Error ? e.message : String(e)
    loading.value = false
  }
}
onMounted(load)
onUnmounted(stop)

function nodeRadius(node: SimNode): number {
  return 10 + Math.min(18, node.degree * 3)
}

const byIdMap = computed(() => new Map(nodes.value.map((n) => [n.id, n])))
function nodeX(id: string): number {
  return byIdMap.value.get(id)?.x ?? 0
}
function nodeY(id: string): number {
  return byIdMap.value.get(id)?.y ?? 0
}

// 悬停高亮邻居
const neighbors = computed<Set<string>>(() => {
  const h = hoverId.value
  if (!h) return new Set()
  const s = new Set<string>([h])
  for (const e of edges.value) {
    if (e.from === h) s.add(e.to)
    if (e.to === h) s.add(e.from)
  }
  return s
})
function isDim(id: string): boolean {
  return hoverId.value !== null && !neighbors.value.has(id)
}
function edgeDim(e: SimEdge): boolean {
  return hoverId.value !== null && e.from !== hoverId.value && e.to !== hoverId.value
}

// --- 拖拽 + 点击跳卡（D2）---
const svgRef = ref<SVGSVGElement | null>(null)
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
  evt.stopPropagation() // 阻止冒泡到背景 pan
  dragNode = node
  dragMoved = false
  downX = evt.clientX
  downY = evt.clientY
  node.fixed = true
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
    if (dx * dx + dy * dy < 16) return // <4px 视为点击（容忍手抖）
    dragMoved = true
  }
  const p = svgPoint(evt)
  dragNode.x = p.x - dragOffX
  dragNode.y = p.y - dragOffY
  dragNode.vx = 0
  dragNode.vy = 0
  start()
}
function onNodeUp(): void {
  const n = dragNode
  if (n && !dragMoved) void openCharacter(n) // 未拖动 → 点击跳卡
  if (n) n.fixed = false
  dragNode = null
  window.removeEventListener('mousemove', onNodeMove)
  window.removeEventListener('mouseup', onNodeUp)
  kick()
}

/** 点击角色节点 → 打开角色卡 tab（D2）。无 file / 不在树中 → 忽略。 */
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

// --- 缩放 + 平移（D2）---
function onWheel(evt: WheelEvent): void {
  const p = svgPoint(evt)
  const scale = evt.deltaY > 0 ? 1.15 : 1 / 1.15
  const nw = Math.max(W * 0.2, Math.min(W * 4, view.value.w * scale))
  if (nw === view.value.w) return
  const sx = nw / view.value.w
  // 以鼠标为中心缩放
  view.value.x = p.x - (p.x - view.value.x) * sx
  view.value.y = p.y - (p.y - view.value.y) * sx
  view.value.w = nw
  view.value.h = nw / (W / H)
}
let panning = false
let panStart = { x: 0, y: 0, vx: 0, vy: 0 }
function onBgDown(evt: MouseEvent): void {
  // 仅背景触发平移；节点 mousedown 已 stopPropagation
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
  view.value = { x: 0, y: 0, w: W, h: H }
}

// --- 边着色（D2：按关系语义关键词分类）---
function edgeColor(e: SimEdge): string {
  if (e.kind === 'debt') return '#c0392b' // 债务 = 暗红虚线
  const t = e.type
  if (/敌|仇|恨/.test(t)) return '#e05260' // 敌对红
  if (/师|徒|长|父|母|养/.test(t)) return '#52a8e0' // 长辈/师徒蓝
  if (/情|爱|恋|妻|夫|婚/.test(t)) return '#e072a8' // 亲密粉
  if (/兄|弟|姐|妹|友|同/.test(t)) return '#7ac52b' // 同辈绿
  if (/主|仆|属|下|臣/.test(t)) return '#e0a838' // 从属橙
  return '#8a8a8a' // 其他灰
}

const nodeCount = computed(() => nodes.value.length)
const edgeCount = computed(() => edges.value.length)
const debtCount = computed(() => edges.value.filter((e) => e.kind === 'debt').length)
</script>

<template>
  <div class="rel-scroll">
    <div v-if="loading" class="placeholder">载入关系图…</div>
    <div v-else-if="err" class="err-block">
      关系图载入失败：{{ err }}
      <button class="btn" @click="load">重试</button>
    </div>
    <div v-else-if="isShort" class="placeholder">短篇集无角色关系图。</div>
    <div v-else-if="!nodeCount" class="placeholder">
      无角色数据。先在「定稿/设定/角色/」建角色卡。
    </div>
    <div v-else class="rel">
      <div class="rel-bar">
        <span class="count">{{ nodeCount }} 角色 · {{ edgeCount }} 关系<span v-if="debtCount">（含 {{ debtCount }} 债务）</span></span>
        <div class="rel-tools">
          <span class="hint">拖拽重排 · 滚轮缩放 · 点节点跳卡</span>
          <button class="tool-btn" title="重置视图" @click="resetView">复位</button>
        </div>
      </div>
      <div class="legend-row">
        <span class="lg"><span class="lg-node lg-big"></span><span class="lg-node lg-small"></span>大小=出场度</span>
        <span class="lg"><span class="lg-node lg-gray"></span>无资料卡</span>
        <span class="lg"><span class="lg-line"></span>关系</span>
        <span class="lg"><span class="lg-line lg-debt"></span>债务</span>
      </div>
      <svg
        ref="svgRef"
        class="graph"
        :viewBox="viewBoxStr"
        preserveAspectRatio="xMidYMid meet"
        @wheel.prevent="onWheel"
        @mousedown="onBgDown"
      >
        <!-- 边（关系实线按语义着色 / 债务虚线暗红） -->
        <g class="edges">
          <g v-for="(e, i) in edges" :key="i" :class="{ dim: edgeDim(e) }">
            <line
              :x1="nodeX(e.from)" :y1="nodeY(e.from)" :x2="nodeX(e.to)" :y2="nodeY(e.to)"
              class="edge" :class="{ debt: e.kind === 'debt' }" :stroke="edgeColor(e)"
            />
            <text
              :x="(nodeX(e.from) + nodeX(e.to)) / 2"
              :y="(nodeY(e.from) + nodeY(e.to)) / 2"
              class="edge-label" :fill="edgeColor(e)"
              text-anchor="middle"
            >{{ e.type }}</text>
          </g>
        </g>
        <!-- 节点 -->
        <g class="nodes">
          <g
            v-for="n in nodes"
            :key="n.id"
            :class="{ dim: isDim(n.id), hover: hoverId === n.id, clickable: n.hasCard && !!n.file }"
            @mousedown="onNodeDown(n, $event)"
            @mouseenter="hoverId = n.id"
            @mouseleave="hoverId = null"
          >
            <circle :cx="n.x" :cy="n.y" :r="nodeRadius(n)" class="node" :class="{ 'no-card': !n.hasCard }" />
            <text :x="n.x" :y="n.y + nodeRadius(n) + 13" class="node-label" text-anchor="middle">{{ n.id }}</text>
          </g>
        </g>
      </svg>
    </div>
  </div>
</template>

<style scoped>
.rel-scroll {
  height: 100%;
  overflow: auto;
  padding: var(--size-4-4) var(--size-4-6);
}
.rel {
  max-width: 860px;
  margin: 0 auto;
}
.rel-bar {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  margin-bottom: var(--size-4-2);
}
.legend-row {
  display: flex;
  flex-wrap: wrap;
  gap: var(--size-4-3);
  margin-bottom: var(--size-4-2);
  padding: 0 2px;
  font-size: 11px;
  color: var(--text-faint);
}
.lg {
  display: inline-flex;
  align-items: center;
  gap: 5px;
}
.lg-node {
  display: inline-block;
  border-radius: 50%;
  background: var(--interactive-accent);
}
.lg-big { width: 12px; height: 12px; }
.lg-small { width: 7px; height: 7px; }
.lg-gray { width: 10px; height: 10px; background: var(--text-faint); opacity: 0.5; }
.lg-line {
  display: inline-block;
  width: 18px;
  height: 0;
  border-top: 1.5px solid var(--interactive-accent);
}
.lg-line.lg-debt {
  border-top: 1.5px dashed #c0392b;
}
.count {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-normal);
}
.hint {
  font-size: 11px;
  color: var(--text-faint);
}
.graph {
  width: 100%;
  height: auto;
  aspect-ratio: 820 / 560;
  background: var(--background-secondary);
  border: 1px solid var(--background-modifier-border);
  border-radius: var(--radius-m);
  cursor: grab;
}
.graph:active {
  cursor: grabbing;
}
.edge {
  stroke: var(--background-modifier-border);
  stroke-width: 1.2;
  transition: opacity 0.15s;
}
.edge-label {
  fill: var(--text-faint);
  font-size: 10px;
  paint-order: stroke;
  stroke: var(--background-secondary);
  stroke-width: 3;
  pointer-events: none;
  opacity: 0.6;
  transition: opacity 0.15s;
}
.node {
  fill: var(--interactive-accent);
  stroke: var(--background-secondary);
  stroke-width: 2;
  cursor: grab;
  transition: opacity 0.15s;
}
.node.no-card {
  fill: var(--text-faint);
  opacity: 0.5;
}
.edge.debt {
  stroke-dasharray: 5 4;
  stroke-width: 1.5;
}
g.clickable {
  cursor: pointer;
}
.rel-tools {
  display: flex;
  align-items: baseline;
  gap: var(--size-4-3);
}
.tool-btn {
  padding: 2px 8px;
  font-size: 11px;
  border: 1px solid var(--background-modifier-border);
  border-radius: var(--radius-s);
  background: var(--background-primary);
  color: var(--text-muted);
  cursor: pointer;
}
.tool-btn:hover {
  background: var(--background-modifier-hover);
  color: var(--text-normal);
}
.node-label {
  fill: var(--text-normal);
  font-size: 11px;
  pointer-events: none;
  transition: opacity 0.15s;
}
.dim {
  opacity: 0.12;
}
g.hover .node {
  stroke: var(--text-accent);
  stroke-width: 3;
}
.placeholder {
  padding: var(--size-4-6);
  text-align: center;
  color: var(--text-faint);
  font-size: 13px;
}
.placeholder code {
  background: var(--background-modifier-border);
  padding: 1px 4px;
  border-radius: 3px;
  font-size: 12px;
}
.err-block {
  padding: var(--size-4-4);
  text-align: center;
  color: var(--text-error);
  font-size: 13px;
}
.btn {
  margin-left: var(--size-4-2);
  padding: 4px 12px;
  font-size: 12px;
  border: 1px solid var(--background-modifier-border);
  border-radius: var(--radius-s);
  background: var(--background-primary);
  color: var(--text-normal);
  cursor: pointer;
}
</style>
