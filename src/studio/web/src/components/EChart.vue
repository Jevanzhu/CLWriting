<script setup lang="ts">
// EChart 包装：echarts 用 canvas 渲染**不认 CSS var()**——option 里的 'var(--xxx)'
// 统一经 resolveVar 递归解析为 :root token 实色，否则图表显默认蓝/黑，不达 mono。
import { ref, onMounted, onUnmounted, watch } from 'vue'
import { init, use, type EChartsType } from 'echarts/core'
import { BarChart, GraphChart, HeatmapChart, LineChart } from 'echarts/charts'
import {
  CalendarComponent,
  GridComponent,
  MarkLineComponent,
  MarkPointComponent,
  TitleComponent,
  TooltipComponent,
  VisualMapComponent,
} from 'echarts/components'
import { CanvasRenderer } from 'echarts/renderers'
import type { EChartsOption } from 'echarts'

use([
  BarChart,
  LineChart,
  GraphChart,
  HeatmapChart,
  CalendarComponent,
  GridComponent,
  MarkLineComponent,
  MarkPointComponent,
  TitleComponent,
  TooltipComponent,
  VisualMapComponent,
  CanvasRenderer,
])

const props = defineProps<{ option: EChartsOption | null }>()
const el = ref<HTMLElement>()
let chart: EChartsType | null = null

/** 递归把 option 里的 'var(--xxx)' 解析为 :root token 实色（echarts canvas 不认 CSS var）。 */
function resolveVar<T>(v: T): T {
  if (typeof v === 'string') {
    const m = v.match(/^var\(\s*(--[\w-]+)\s*\)$/)
    if (m) {
      const val = getComputedStyle(document.documentElement).getPropertyValue(m[1]).trim()
      if (val) return val as unknown as T
    }
    return v
  }
  if (Array.isArray(v)) return v.map(resolveVar) as unknown as T
  if (v && typeof v === 'object') {
    const o: Record<string, unknown> = {}
    for (const k in v as object) o[k] = resolveVar((v as Record<string, unknown>)[k])
    return o as unknown as T
  }
  return v
}

onMounted(() => {
  if (el.value) chart = init(el.value)
  if (chart && props.option) chart.setOption(resolveVar(props.option))
})

watch(
  () => props.option,
  (o) => {
    if (chart && o) chart.setOption(resolveVar(o), true)
  },
)

onUnmounted(() => chart?.dispose())
</script>

<template>
  <div ref="el" class="echart"></div>
</template>

<style scoped>
.echart {
  width: 100%;
  height: 280px;
}
</style>
