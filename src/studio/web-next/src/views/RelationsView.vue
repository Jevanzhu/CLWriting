<script setup lang="ts">
// 角色关系图（块5 D1）：GET /settings → 节点(characters)+边(characterRelations)
// 力导向布局（斥力+引力+中心引力+阻尼）→ SVG 渲染 → 悬停高亮邻边 + 拖拽节点。
// 纯 SVG 无图表库；数据源 #7.5 settings 端点（parseRelations 派生自角色卡「关系」字段）。
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { getSettings, type CharacterCard, type RelationEdge } from '../api/settings'

const props = defineProps<{ bookName: string }>()

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
interface SimEdge { from: string; to: string; type: string }

// 画布 + 物理参数（经验初值，手感调）
const W = 820
const H = 560
const CX = W / 2
const CY = H / 2
const REPULSION = 6000
const ATTRACTION = 0.03
const IDEAL_LEN = 130
const CENTER_GRAVITY = 0.015
const DAMPING = 0.82

const nodes = ref<SimNode[]>([])
const edges = ref<SimEdge[]>([])
const loading = ref(true)
const err = ref<string | null>(null)
const isShort = ref(false)
const hoverId = ref<string | null>(null)

let rafId = 0
let running = false

function buildGraph(characters: CharacterCard[], rels: RelationEdge[]): void {
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
    valid.push({ from: r.from, to: r.to, type: r.type })
    ensure(r.from, byId.has(r.from) ? byId.get(r.from)!.hasCard : false)
    ensure(r.to, byId.has(r.to) ? byId.get(r.to)!.hasCard : false)
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
    buildGraph(r.characters, r.characterRelations)
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

// --- 拖拽 ---
const svgRef = ref<SVGSVGElement | null>(null)
let dragNode: SimNode | null = null
let dragOffX = 0
let dragOffY = 0

function svgPoint(evt: MouseEvent): { x: number; y: number } {
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
  dragNode = node
  node.fixed = true
  const p = svgPoint(evt)
  dragOffX = p.x - node.x
  dragOffY = p.y - node.y
  window.addEventListener('mousemove', onNodeMove)
  window.addEventListener('mouseup', onNodeUp)
}
function onNodeMove(evt: MouseEvent): void {
  if (!dragNode) return
  const p = svgPoint(evt)
  dragNode.x = p.x - dragOffX
  dragNode.y = p.y - dragOffY
  dragNode.vx = 0
  dragNode.vy = 0
  start()
}
function onNodeUp(): void {
  if (dragNode) dragNode.fixed = false
  dragNode = null
  window.removeEventListener('mousemove', onNodeMove)
  window.removeEventListener('mouseup', onNodeUp)
  kick()
}

const nodeCount = computed(() => nodes.value.length)
const edgeCount = computed(() => edges.value.length)
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
        <span class="count">{{ nodeCount }} 角色 · {{ edgeCount }} 关系</span>
        <span class="hint">拖拽节点重排 · 悬停高亮邻接</span>
      </div>
      <svg ref="svgRef" class="graph" :viewBox="`0 0 ${W} ${H}`" preserveAspectRatio="xMidYMid meet">
        <!-- 边 -->
        <g class="edges">
          <g v-for="(e, i) in edges" :key="i" :class="{ dim: edgeDim(e) }">
            <line :x1="nodeX(e.from)" :y1="nodeY(e.from)" :x2="nodeX(e.to)" :y2="nodeY(e.to)" class="edge" />
            <text
              :x="(nodeX(e.from) + nodeX(e.to)) / 2"
              :y="(nodeY(e.from) + nodeY(e.to)) / 2"
              class="edge-label"
              text-anchor="middle"
            >{{ e.type }}</text>
          </g>
        </g>
        <!-- 节点 -->
        <g class="nodes">
          <g
            v-for="n in nodes"
            :key="n.id"
            :class="{ dim: isDim(n.id), hover: hoverId === n.id }"
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
