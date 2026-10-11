<script setup lang="ts">
// 关系图主图组件（RelationsView 拆分）：SVG 节点/边渲染 + 缩放平移拖拽 + 图例。
// 状态与交互逻辑全部在 useRelationGraph composable（provide 注入），本组件只做渲染。
import { computed, ref } from 'vue'
import { useRelationGraphInjected, CX, CY, type SimNode } from '../../composables/useRelationGraph'
import { isImeComposing } from '../../shared/ime'

const g = useRelationGraphInjected()

/** #20：边 key 弃 '-' 裸拼接（自由文本名可含 '-'，from/to 分段歧义撞 key）——
 *  \u0000 分隔防拼接歧义（对齐 stores/learn.ts sampleKey/quoteKey 同款口径） */
function edgeKey(e: { from: string; to: string; kind: string }): string {
  return `${e.from}\u0000${e.to}\u0000${e.kind}`
}

/** 键盘焦点所在节点（roving tabindex 停靠点；null = 未进入节点区，回落选中节点） */
const kbId = ref<string | null>(null)
/** 节点层容器：方向键跳转按 DOM 序取元素（DOM 序 = visibleNodes 序，同一 v-for 源） */
const nodesEl = ref<SVGGElement | null>(null)

/** 唯一 Tab 停靠节点：键盘已进入优先，否则跟随选中（默认中心角色），再回落首可见节点。
 *  节点集合随搜索/图例过滤变化，故每次现算而不缓存 id——被滤掉的停靠点不得留 tabindex=0。 */
const tabstopId = computed<string | null>(() => {
  const ids = g.visibleNodes.value.map((n) => n.id)
  if (kbId.value && ids.includes(kbId.value)) return kbId.value
  const sel = g.selectedId.value
  if (sel && ids.includes(sel)) return sel
  return ids[0] ?? null
})

/** 读屏名：角色名 + 有无角色卡（无卡节点不可打开角色卡，名字须自证） */
function nodeAriaLabel(n: SimNode): string {
  return n.hasCard ? `${n.id}（有角色卡）` : `${n.id}（仅被提及）`
}

/** 焦点移到第 idx 个可见节点 */
function focusNodeAt(idx: number): void {
  const el = nodesEl.value?.children[idx] as SVGGElement | undefined
  el?.focus()
}

/** 方向键就近跳：按键方向半平面内取「主轴距离 + 2×侧向偏移」最小者（无候选则不动）。
 *  径向布局没有行列序，按节点当前位置（拖拽后亦然）几何就近才有空间直觉。 */
function moveFocus(from: SimNode, key: string): void {
  const nodes = g.visibleNodes.value
  let best: SimNode | null = null
  let bestScore = Infinity
  for (const n of nodes) {
    if (n.id === from.id) continue
    const dx = n.x - from.x
    const dy = n.y - from.y
    const main = key === 'ArrowLeft' ? -dx : key === 'ArrowRight' ? dx : key === 'ArrowUp' ? -dy : dy
    if (main <= 0) continue
    const side = key === 'ArrowLeft' || key === 'ArrowRight' ? Math.abs(dy) : Math.abs(dx)
    const score = main + side * 2
    if (score < bestScore) {
      bestScore = score
      best = n
    }
  }
  if (!best) return
  kbId.value = best.id
  focusNodeAt(nodes.indexOf(best))
}

/** 节点键盘路径：Enter/Space 选中（走既有 selectNode，右侧详情随之联动，不新造语义），
 *  方向键在节点间跳。dblclick 的复位另有工具栏「复位」按钮可达，故不另设键。 */
function onNodeKey(n: SimNode, e: KeyboardEvent): void {
  if (isImeComposing(e)) return // 组合期按键归输入法（同全仓判据）
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault() // 空格默认滚动页面、Enter 可能触发宿主默认行为
    g.selectNode(n.id)
    return
  }
  if (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'ArrowUp' || e.key === 'ArrowDown') {
    e.preventDefault()
    moveFocus(n, e.key)
  }
}
</script>

<template>
  <div class="rel-graph">
    <!-- 根非 role="img"：img 是叶子角色，整棵节点/边会被读屏当一张图片、节点不可达；
         group 让节点（role=button）作为子项逐个可达 -->
    <svg
      :ref="g.bindSvg"
      class="graph"
      :viewBox="g.viewBoxStr.value"
      preserveAspectRatio="xMidYMid meet"
      role="group"
      aria-label="关系图"
      @wheel.prevent="g.onWheel"
      @mousedown="g.onBgDown"
    >
      <defs>
        <pattern id="rel-dotgrid" width="24" height="24" patternUnits="userSpaceOnUse">
          <circle cx="12" cy="12" r="0.8" class="dot-bg" />
        </pattern>
      </defs>
      <rect x="-9999" y="-9999" width="19998" height="19998" class="bg-rect" />
      <!-- 边：默认就带语义色（弱），聚焦时提到全饱和 -->
      <g class="edges">
        <!-- key 弃纯 index——edges 按 pairKey(from,to,kind) 无向去重后建边，
             (from, to, kind) 必唯一（同域节点 :key="n.id" 先例），即天然稳定键。
 #20：拼接改 \u0000 分隔（'-' 裸拼自由文本名理论撞 key） -->
        <g v-for="g2 in g.edgeGeoms.value" :key="edgeKey(g2.e)" :class="{ dim: g.edgeDim(g2.e) }">
          <path
            :d="g2.d"
            class="edge"
            :class="{ debt: g2.e.kind === 'debt', active: g.edgeActive(g2.e) }"
            :style="{ stroke: g.edgeColor(g2.e) }"
          />
          <text
            :x="g2.mx"
            :y="g2.my"
            class="edge-label"
            :class="{ active: g.edgeActive(g2.e) }"
            :style="{ fill: g.edgeColor(g2.e) }"
            text-anchor="middle"
            dy="0.32em"
          >
            {{ g2.e.type }}
            <title v-if="g2.e.note">{{ g2.e.note }}</title>
          </text>
        </g>
      </g>
      <!-- 节点：胶囊内嵌角色名（名字即节点）；键盘面 = roving tabindex（全图一个 Tab 停靠点）
           + 方向键跳 + Enter/Space 选中 -->
      <g ref="nodesEl" class="nodes" :style="{ '--rel-cx': `${CX}px`, '--rel-cy': `${CY}px` }">
        <g
          v-for="n in g.visibleNodes.value"
          :key="n.id"
          class="node-g"
          role="button"
          :aria-label="nodeAriaLabel(n)"
          :aria-current="g.selectedId.value === n.id ? 'true' : undefined"
          :tabindex="tabstopId === n.id ? 0 : -1"
          :class="{
            dim: g.isDim(n.id),
            hover: g.hoverId.value === n.id,
            selected: g.selectedId.value === n.id,
            clickable: n.hasCard && !!n.file,
            center: n.isCenter,
            'no-card': !n.hasCard,
            dragging: g.dragId.value === n.id,
          }"
          :style="{
            transform: `translate(${n.x}px, ${n.y}px)`,
            animationDelay: `${n.ring * 90}ms`,
            '--nc': g.nodeColor(n),
          }"
          @mousedown="g.onNodeDown(n, $event)"
          @dblclick="g.onNodeDblClick(n)"
          @mouseenter="g.hoverId.value = n.id"
          @mouseleave="g.hoverId.value = null"
          @focus="g.hoverId.value = n.id"
          @blur="g.hoverId.value = null"
          @keydown="onNodeKey(n, $event)"
        >
          <!-- 选中态外环（默认透明，hover/选中浮现） -->
          <rect
            :x="-(g.nodeW(n) + 10) / 2"
            :y="-(g.nodeH(n) + 10) / 2"
            :width="g.nodeW(n) + 10"
            :height="g.nodeH(n) + 10"
            :rx="(g.nodeH(n) + 10) / 2"
            class="node-halo"
          />
          <!-- 胶囊本体（不透明填充盖住穿过的边线） -->
          <rect
            :x="-g.nodeW(n) / 2"
            :y="-g.nodeH(n) / 2"
            :width="g.nodeW(n)"
            :height="g.nodeH(n)"
            :rx="g.nodeRx(n)"
            class="node"
          />
          <text
            x="0"
            y="0"
            class="node-label"
            :style="{ fontSize: `${g.nodeFontSize(n)}px` }"
            text-anchor="middle"
            dominant-baseline="central"
          >
            {{ n.id }}
          </text>
        </g>
      </g>
    </svg>
    <!-- 图例：压成一行 chips，浮在图底部，不再占据竖向空间。
         可点的类型 chip 是按钮（键盘可达），非交互说明项保持 span -->
    <div class="legend" role="group" aria-label="关系类型图例">
      <button
        v-for="l in g.activeLegend.value"
        :key="l.label"
        type="button"
        class="lg clickable"
        :class="{ off: g.hiddenColors.value.has(l.color) }"
        :aria-pressed="!g.hiddenColors.value.has(l.color)"
        @click="g.toggleColor(l.color)"
      >
        <i class="lg-line" :style="{ background: l.color }"></i>{{ l.label }}
      </button>
      <span v-if="g.debtCount.value" class="lg">
        <i class="lg-line debt" :style="{ color: 'var(--cat-1)' }"></i>债务
      </span>
      <span class="lg"><i class="lg-pill gray"></i>仅被提及</span>
    </div>
  </div>
</template>

<style scoped>
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
.lg.clickable {
  /* chip 由 span 改 button：清 UA 按钮外观（padding/border/背景/字体），保持原 chip 视觉 */
  padding: 0;
  border: none;
  background: none;
  color: inherit;
  font: inherit;
  cursor: pointer;
  user-select: none;
  transition: opacity var(--dur-fast) var(--ease-out);
}
.lg.clickable:hover {
  opacity: 0.7;
}
.lg.clickable.off {
  opacity: 0.3;
}
.lg.clickable:focus-visible {
  outline: 2px solid var(--interactive-accent);
  outline-offset: 2px;
  border-radius: var(--radius-s);
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
  background-image: repeating-linear-gradient(to right, currentColor 0 4px, transparent 4px 7px);
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
  transition:
    opacity var(--dur-fast) var(--ease-out),
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
  opacity: 0.45;
  transition: opacity var(--dur-fast) var(--ease-out);
}
.edge-label.active {
  opacity: 1;
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
  transition:
    opacity var(--dur-fast) var(--ease-out),
    fill var(--dur-fast) var(--ease-out);
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
/* 键盘焦点可见：沿用 hover/选中同款外环，不另造视觉语言 */
.node-g:focus-visible .node-halo {
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
</style>
