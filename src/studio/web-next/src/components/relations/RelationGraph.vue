<script setup lang="ts">
// 关系图主图组件（RelationsView 拆分 P2-5）：SVG 节点/边渲染 + 缩放平移拖拽 + 图例。
// 状态与交互逻辑全部在 useRelationGraph composable（provide 注入），本组件只做渲染。
import { useRelationGraphInjected, CX, CY } from '../../composables/useRelationGraph'

const g = useRelationGraphInjected()
</script>

<template>
  <div class="rel-graph">
    <svg
      :ref="g.bindSvg"
      class="graph"
      :viewBox="g.viewBoxStr.value"
      preserveAspectRatio="xMidYMid meet"
      role="img"
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
        <g v-for="(g2, i) in g.edgeGeoms.value" :key="i" :class="{ dim: g.edgeDim(g2.e) }">
          <path
            :d="g2.d"
            class="edge" :class="{ debt: g2.e.kind === 'debt', active: g.edgeActive(g2.e) }"
            :style="{ stroke: g.edgeColor(g2.e) }"
          />
          <text
            :x="g2.mx" :y="g2.my"
            class="edge-label" :class="{ active: g.edgeActive(g2.e) }"
            :style="{ fill: g.edgeColor(g2.e) }"
            text-anchor="middle" dy="0.32em"
          >{{ g2.e.type }}<title v-if="g2.e.note">{{ g2.e.note }}</title></text>
        </g>
      </g>
      <!-- 节点：胶囊内嵌角色名（名字即节点） -->
      <g class="nodes" :style="{ '--rel-cx': `${CX}px`, '--rel-cy': `${CY}px` }">
        <g
          v-for="n in g.visibleNodes.value"
          :key="n.id"
          class="node-g"
          :class="{
            dim: g.isDim(n.id), hover: g.hoverId.value === n.id, selected: g.selectedId.value === n.id,
            clickable: n.hasCard && !!n.file, center: n.isCenter,
            'no-card': !n.hasCard, dragging: g.dragId.value === n.id,
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
        >
          <!-- 选中态外环（默认透明，hover/选中浮现） -->
          <rect
            :x="-(g.nodeW(n) + 10) / 2" :y="-(g.nodeH(n) + 10) / 2"
            :width="g.nodeW(n) + 10" :height="g.nodeH(n) + 10"
            :rx="(g.nodeH(n) + 10) / 2"
            class="node-halo"
          />
          <!-- 胶囊本体（不透明填充盖住穿过的边线） -->
          <rect
            :x="-g.nodeW(n) / 2" :y="-g.nodeH(n) / 2"
            :width="g.nodeW(n)" :height="g.nodeH(n)"
            :rx="g.nodeRx(n)"
            class="node"
          />
          <text
            x="0" y="0"
            class="node-label" :style="{ fontSize: `${g.nodeFontSize(n)}px` }"
            text-anchor="middle" dominant-baseline="central"
          >{{ n.id }}</text>
        </g>
      </g>
    </svg>
    <!-- 图例：压成一行 chips，浮在图底部，不再占据竖向空间 -->
    <div class="legend">
      <span
        v-for="l in g.activeLegend.value" :key="l.label"
        class="lg clickable" :class="{ off: g.hiddenColors.value.has(l.color) }"
        @click="g.toggleColor(l.color)"
      >
        <i class="lg-line" :style="{ background: l.color }"></i>{{ l.label }}
      </span>
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
</style>
