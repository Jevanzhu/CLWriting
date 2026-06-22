<script setup lang="ts">
import { ref, onMounted, onUnmounted, watch } from 'vue'
import * as echarts from 'echarts'
import type { EChartsOption } from 'echarts'

const props = defineProps<{ option: EChartsOption | null }>()
const el = ref<HTMLElement>()
let chart: echarts.ECharts | null = null

onMounted(() => {
  if (el.value) chart = echarts.init(el.value)
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
