<script setup lang="ts">
/**
 * 总览 ③ 字数曲线面板（hh §八-16 自 OverviewView.vue 拆出，纯搬家）。
 * 面积图 SVG：实线 hairline 网格 + 均章参考线 + 折线端点（M-P3-14 按 tickStep
 * 降采样，与 X 轴标签同口径）+ X 轴降采样标签。
 */
import { computed } from 'vue'
import { TrendingUp } from 'lucide-vue-next'
import type { RhythmResult } from '../../api/rhythm'

const props = defineProps<{
  rhythmData: RhythmResult | null
}>()

// ── 字数曲线 SVG 尺度（面积图）──
const CHART_W = 880
const CHART_H = 180
const PAD_BOTTOM = 24 // 章号标签
const PAD_LEFT = 38   // Y 轴刻度标签
const DRAW_W = CHART_W - PAD_LEFT
/** 字数曲线点（长短篇统一：章号 → no）。 */
const curve = computed<{ no: number; 标题: string; 字数: number }[]>(() => {
  const d = props.rhythmData
  if (!d) return []
  // 长短篇 wordCurve 均用 章号（短篇已统一），无需按 kind 分支
  return d.wordCurve.map((p) => ({ no: p.章号, 标题: p.标题, 字数: p.字数 }))
})
const curveAvg = computed(() => {
  const c = curve.value
  return c.length ? Math.round(c.reduce((s, p) => s + p.字数, 0) / c.length) : 0
})
const maxWords = computed(() => Math.max(1, ...curve.value.map((p) => p.字数)))
const Y_TICKS = [0.25, 0.5, 0.75]
/** X 轴标签步长：控制在 ~20 个标签内。超 40 章就整排隐藏会让长篇横轴彻底失去参照。 */
const tickStep = computed(() => {
  const n = curve.value.length
  return Math.max(1, Math.ceil(n / 20))
})
/** 字数简写：≥1万→X.X万，≥1千→X.Xk，其余原值 */
function fmtWords(n: number): string {
  if (n >= 10000) return `${(n / 10000).toFixed(1)}万`
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`
  return String(Math.round(n))
}
/** 面积/折线图点 x（章节槽中心）*/
function ptX(i: number, n: number): number {
  const slot = DRAW_W / Math.max(1, n)
  return PAD_LEFT + i * slot + slot * 0.5
}
/** 点 y（字数→高度）*/
function barY(字数: number): number {
  const h = (字数 / maxWords.value) * (CHART_H - PAD_BOTTOM - 14)
  return CHART_H - PAD_BOTTOM - h
}
const avgY = computed(() => {
  const c = curve.value
  return c.length ? barY(curveAvg.value) : 0
})
/** 面积路径 d（底→各点→底→闭合）*/
const wordAreaD = computed(() => {
  const pts = curve.value
  if (!pts.length) return ''
  const n = pts.length
  const baseY = CHART_H - PAD_BOTTOM
  const ptsStr = pts.map((p, i) => `${ptX(i, n)},${barY(p.字数)}`).join(' L ')
  return `M ${ptX(0, n)},${baseY} L ${ptsStr} L ${ptX(n - 1, n)},${baseY} Z`
})
/** 折线路径 d */
const wordLineD = computed(() => {
  const pts = curve.value
  if (!pts.length) return ''
  const n = pts.length
  return pts.map((p, i) => `${i === 0 ? 'M' : 'L'} ${ptX(i, n)},${barY(p.字数)}`).join(' ')
})
</script>

<template>
  <section v-if="curve.length" class="panel">
    <div class="panel-head">
      <TrendingUp :size="14" /> <span>字数曲线</span>
      <span class="head-legend">{{ curve.length }} 章 · 均章 {{ curveAvg.toLocaleString() }} 字</span>
    </div>
    <!-- R72-11（二十轮 E-9）：删内层空态死分支——外层 v-if="curve.length" 已保证非空，
         内层反条件 v-if 永不成立（svg 的 v-else 随之删属性） -->
    <svg
      class="chart-svg"
      :viewBox="`0 0 ${CHART_W} ${CHART_H}`"
      preserveAspectRatio="xMidYMid meet"
      role="img"
      aria-label="字数曲线"
    >
      <defs>
        <linearGradient id="wordAreaGrad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" style="stop-color: var(--interactive-accent); stop-opacity: 0.2;" />
          <stop offset="100%" style="stop-color: var(--interactive-accent); stop-opacity: 0.01;" />
        </linearGradient>
      </defs>
      <!-- Y 轴实线网格 -->
      <g v-for="(t, idx) in Y_TICKS" :key="idx">
        <line :x1="PAD_LEFT" :x2="CHART_W" :y1="barY(maxWords * t)" :y2="barY(maxWords * t)" class="grid-line" />
        <text :x="PAD_LEFT - 8" :y="barY(maxWords * t) + 3" class="grid-label" text-anchor="end">{{ fmtWords(maxWords * t) }}</text>
      </g>
      <!-- 基线 -->
      <line :x1="PAD_LEFT" :x2="CHART_W" :y1="CHART_H - PAD_BOTTOM" :y2="CHART_H - PAD_BOTTOM" class="axis-baseline" />
      <!-- 面积填充 -->
      <path :d="wordAreaD" fill="url(#wordAreaGrad)" />
      <!-- 均章参考线 -->
      <line :x1="PAD_LEFT" :x2="CHART_W" :y1="avgY" :y2="avgY" class="avg-line" />
      <text :x="CHART_W - 6" :y="avgY - 5" class="avg-text" text-anchor="end">均章 {{ fmtWords(curveAvg) }}</text>
      <!-- 折线 -->
      <path :d="wordLineD" class="word-line" />
      <!-- 端点（内存核查 2026-08-25 M-P3-14：按 tickStep 降采样——2000 章全量
           circle+title ≈4000 节点只靠视觉裁剪不减 DOM；现仅每隔 step 章画点，
           与 X 轴标签同口径，title 悬浮语义保留在画出的点上；折线路径不动） -->
      <template v-for="(p, i) in curve" :key="'dot'+p.no">
        <circle v-if="i % tickStep === 0" :cx="ptX(i, curve.length)" :cy="barY(p.字数)" r="2.5" class="word-dot">
          <title>第{{ p.no }}章 {{ p.标题 }} · {{ p.字数.toLocaleString() }} 字</title>
        </circle>
      </template>
      <!-- X 轴编号（按 tickStep 降采样，长篇也保留横轴参照）-->
      <template v-for="(p, i) in curve" :key="'wl'+p.no">
        <text
          v-if="i % tickStep === 0"
          :x="ptX(i, curve.length)"
          :y="CHART_H - 8"
          class="axis-label-x"
          text-anchor="middle"
        >{{ p.no }}</text>
      </template>
    </svg>
  </section>
</template>

<style scoped>
/* 面板基础（与 OverviewView 同式） */
.panel {
  background: var(--background-primary);
  border: 1px solid var(--background-modifier-border);
  border-radius: var(--radius-l);
  padding: 18px 20px;
  animation: clw-fade-up var(--dur-fast) var(--ease-out) both;
}

.head-legend { margin-left: auto; font-weight: 400; font-size: var(--font-size-xs); color: var(--text-muted); }
.empty { font-size: var(--font-size-s); color: var(--text-faint); padding: var(--size-4-2) 0; }

/* ══ 字数曲线 SVG（面积图）══ */
.chart-svg { width: 100%; height: auto; display: block; }
.grid-line { stroke: var(--background-modifier-border); stroke-width: 1; }
.axis-baseline { stroke: var(--background-modifier-border); stroke-width: 1; }
.grid-label { fill: var(--text-faint); font-size: var(--font-size-xxs); font-variant-numeric: tabular-nums; }
.axis-label-x { fill: var(--text-faint); font-size: 9px; }
.word-line { fill: none; stroke: var(--interactive-accent); stroke-width: 2; stroke-linejoin: round; stroke-linecap: round; }
.word-dot { fill: var(--interactive-accent); stroke: var(--background-primary); stroke-width: 1.5; }
.avg-line { stroke: var(--text-faint); stroke-width: 1; stroke-dasharray:  4 3; opacity: 0.6; }
.avg-text { fill: var(--text-faint); font-size: var(--font-size-xxs); }
</style>
