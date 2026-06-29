<script setup lang="ts">
import { ref, watch, computed } from 'vue'
import { useRoute } from 'vue-router'
import EChart from '../components/EChart.vue'
import type { EChartsOption, BarSeriesOption, LineSeriesOption } from 'echarts'
import type { Rhythm } from '../types'
import { getRhythm } from '../api/books'

const route = useRoute()
const name = computed(() => (typeof route.params.name === 'string' ? route.params.name : ''))
const enc = computed(() => encodeURIComponent(name.value))
const data = ref<Rhythm | null>(null)
const loading = ref(true)
const error = ref('')

async function load(n: string): Promise<void> {
  loading.value = true
  error.value = ''
  data.value = null
  try {
    data.value = await getRhythm(n)
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    loading.value = false
  }
}

watch(
  () => route.params.name,
  (n) => {
    if (typeof n === 'string') load(n)
  },
  { immediate: true },
)

/** 字数曲线(长篇配均字参考线) */
const wordOption = computed<EChartsOption | null>(() => {
  const d = data.value
  if (!d || d.wordCurve.length === 0) return null
  const xData = d.wordCurve.map((p) => ('章号' in p ? p.章号 : p.篇号))
  const series: LineSeriesOption[] = [
    {
      type: 'line',
      smooth: true,
      data: d.wordCurve.map((p) => p.字数),
      itemStyle: { color: 'var(--ink-cyan)' },
      areaStyle: { opacity: 0.1 },
      markLine: d.kind === 'long' ? { silent: true, data: [{ type: 'average', name: '均字' }] } : undefined,
    },
  ]
  return {
    tooltip: { trigger: 'axis' },
    grid: { left: 56, right: 24, top: 24, bottom: 36 },
    xAxis: { type: 'category', data: xData.map((n) => `${n}`), name: d.kind === 'long' ? '章' : '篇' },
    yAxis: { type: 'value', name: '字数' },
    series,
  }
})

/** 条形分布(通用) */
function barOption(dist: Record<string, number>, title: string): EChartsOption {
  const keys = Object.keys(dist)
  const series: BarSeriesOption[] = [
    {
      type: 'bar',
      data: keys.map((k) => dist[k] ?? 0),
      itemStyle: { color: 'var(--ink-cyan)', borderRadius: [4, 4, 0, 0] },
      label: { show: true, position: 'top' },
    },
  ]
  return {
    title: { text: title, left: 'center', textStyle: { fontSize: 13, fontWeight: 600, color: 'var(--ink)' } },
    tooltip: { trigger: 'axis' },
    grid: { left: 40, right: 20, top: 44, bottom: 32 },
    xAxis: { type: 'category', data: keys },
    yAxis: { type: 'value', minInterval: 1 },
    series,
  }
}

const hookTypeOption = computed<EChartsOption | null>(() => {
  const d = data.value
  return d && d.kind === 'long' ? barOption(d.hookTypeDist, '钩子类型分布') : null
})
const hookLevelOption = computed<EChartsOption | null>(() => {
  const d = data.value
  return d && d.kind === 'long' ? barOption(d.hookLevelDist, '钩子强弱分布') : null
})
const emotionOption = computed<EChartsOption | null>(() => {
  const d = data.value
  return d ? barOption(d.emotionDist, d.kind === 'long' ? '情绪定位分布' : '目标情绪分布') : null
})

/** 场景分布（长篇，#7.4） */
const sceneOption = computed<EChartsOption | null>(() => {
  const d = data.value
  return d && d.kind === 'long' ? barOption(d.sceneDist, '场景分布') : null
})

/** 场景 × 情绪热力矩阵（长篇增强区，#7.4） */
const sceneEmotionOption = computed<EChartsOption | null>(() => {
  const d = data.value
  if (!d || d.kind !== 'long') return null
  const scenes = Object.keys(d.sceneEmotion)
  const emotions = scenes.length ? Object.keys(d.sceneEmotion[scenes[0]] ?? {}) : []
  const heat: [number, number, number][] = []
  let max = 0
  scenes.forEach((sc, i) => {
    emotions.forEach((em, j) => {
      const v = d.sceneEmotion[sc]?.[em] ?? 0
      if (v > max) max = v
      heat.push([j, i, v])
    })
  })
  return {
    title: { text: '场景 × 情绪', left: 'center', textStyle: { fontSize: 13, fontWeight: 600, color: 'var(--ink)' } },
    tooltip: { position: 'top' },
    grid: { left: 84, right: 24, top: 44, bottom: 64 },
    xAxis: { type: 'category', data: emotions, splitArea: { show: true } },
    yAxis: { type: 'category', data: scenes, splitArea: { show: true } },
    visualMap: {
      min: 0, max: Math.max(1, max), calculable: true, orient: 'horizontal',
      left: 'center', bottom: 4,
      inRange: { color: ['var(--border)', 'var(--active-bg)', 'var(--ink-cyan)'] },
    },
    series: [{ type: 'heatmap', data: heat, label: { show: true } }],
  }
})
</script>

<template>
  <section class="rhythm-page">
    <div class="panel-pad">
      <div class="panel-title">节奏</div>
      <div class="panel-sub">{{ data?.kind === 'long' ? '章长 · 钩子 · 场景情绪' : '篇长 · 情绪 · 反转' }}</div>

      <p v-if="loading" class="hint">加载中…</p>
      <p v-else-if="error" class="hint error">加载失败：{{ error }}</p>
      <template v-else-if="data">
        <!-- 字数曲线 -->
        <div class="card">
          <div class="card-title">{{ data.kind === 'long' ? '章长曲线' : '篇长曲线' }}</div>
          <EChart v-if="wordOption" :option="wordOption" />
          <p v-if="data.kind === 'long'" class="avg-line">虚线为均字 {{ data.avgWords }}</p>
        </div>

        <!-- 钩子类型 × 强弱（长篇）-->
        <div v-if="data.kind === 'long'" class="grid-2">
          <div class="card"><EChart v-if="hookTypeOption" :option="hookTypeOption" /></div>
          <div class="card"><EChart v-if="hookLevelOption" :option="hookLevelOption" /></div>
        </div>

        <!-- 情绪分布 -->
        <div class="card"><EChart v-if="emotionOption" :option="emotionOption" /></div>

        <!-- 场景分布 + 场景×情绪（长篇）-->
        <div v-if="data.kind === 'long'" class="grid-2">
          <div class="card"><EChart v-if="sceneOption" :option="sceneOption" /></div>
          <div class="card"><EChart v-if="sceneEmotionOption" :option="sceneEmotionOption" /></div>
        </div>

        <!-- 核心反转（短篇）-->
        <div v-if="data.kind === 'short' && data.reversals.length" class="card">
          <div class="card-title">核心反转<span style="color:var(--text-3);font-weight:normal"> · 点篇名进篇详情</span></div>
          <RouterLink
            v-for="r in data.reversals"
            :key="r.篇号"
            class="list-row rev-link"
            :to="`/books/${enc}/piece/${r.篇号}`"
          >
            <div style="flex:1">
              <div class="t">第 {{ r.篇号 }} 篇 · {{ r.标题 }}</div>
              <div class="m">{{ r.核心反转 }}</div>
            </div>
          </RouterLink>
        </div>
      </template>
    </div>
  </section>
</template>

<style scoped>
.rhythm-page {
  margin: 0 auto;
}
.grid-2 {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
  margin-bottom: 12px;
}
.avg-line {
  margin: 8px 0 0;
  text-align: center;
  font-size: 12px;
  color: var(--text-3);
}
.rev-link {
  text-decoration: none;
  color: inherit;
}
.rev-link:hover .t {
  color: var(--ink-cyan);
}
.rhythm-page :deep(.echart) {
  height: 220px;
}
.rhythm-page .hint {
  color: var(--text-2);
  padding-top: 24px;
}
.rhythm-page .hint.error {
  color: var(--cinnabar);
}
</style>
