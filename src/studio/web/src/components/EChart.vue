<script setup lang="ts">
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

onMounted(() => {
  if (el.value) chart = init(el.value)
  if (chart && props.option) chart.setOption(props.option)
})

watch(
  () => props.option,
  (o) => {
    if (chart && o) chart.setOption(o, true)
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
