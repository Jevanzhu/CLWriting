<script setup lang="ts">
import { ref, watch, computed } from 'vue'
import { useRoute } from 'vue-router'
import EChart from '../components/EChart.vue'
import ErrorState from '../components/ErrorState.vue'
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

/** 字数极值：最低 / 平均 / 最高（从 wordCurve 算，对齐 mockup 最低章·平均章 stat） */
const wordStats = computed(() => {
  const d = data.value
  if (!d || d.wordCurve.length === 0) return null
  const arr = d.wordCurve.map((p) => p.字数)
  const sum = arr.reduce((s, x) => s + x, 0)
  return { avg: Math.round(sum / arr.length), min: Math.min(...arr), max: Math.max(...arr) }
})
</script>

<template>
  <section class="rhythm-page">
    <div class="bento-wrap">
      <div class="bento-head">
        <h1 class="bento-title">{{ data?.kind === 'long' ? '节奏 · 字数曲线' : '节奏 · 情绪起伏' }}</h1>
        <div class="bento-sub">
          <span class="meta-chip">{{ data?.kind === 'long' ? '章长' : '篇长' }}</span>
          <span class="meta-chip">{{ data?.kind === 'long' ? '钩子' : '情绪' }}</span>
          <span class="meta-chip">{{ data?.kind === 'long' ? '场景情绪' : '反转' }}</span>
        </div>
      </div>

      <p v-if="loading" class="hint">加载中…</p>
      <ErrorState v-else-if="error" :msg="error" @retry="load(name)" />
      <div v-else-if="data" class="bento-grid">
        <!-- 字数曲线 -->
        <div v-if="wordOption" class="bento-card bento-full">
          <div class="bc-label">{{ data.kind === 'long' ? '章长曲线' : '篇长曲线' }}</div>
          <EChart :option="wordOption" />
          <p v-if="data.kind === 'long'" class="avg-line">虚线为均字 {{ data.avgWords }}</p>
        </div>
        <!-- 字数极值（对齐 mockup 最低章·平均章 stat） -->
        <div v-if="wordStats" class="bento-card"><div class="bc-menu">⋮</div><div class="bc-label">最低{{ data.kind === 'long' ? '章' : '篇' }}</div><div class="bc-stat" style="color:var(--cinnabar)">{{ wordStats.min }}</div></div>
        <div v-if="wordStats" class="bento-card"><div class="bc-menu">⋮</div><div class="bc-label">平均/{{ data.kind === 'long' ? '章' : '篇' }}</div><div class="bc-stat">{{ wordStats.avg }}</div></div>
        <div v-if="wordStats" class="bento-card"><div class="bc-menu">⋮</div><div class="bc-label">最高{{ data.kind === 'long' ? '章' : '篇' }}</div><div class="bc-stat" style="color:var(--ink-cyan)">{{ wordStats.max }}</div></div>
        <!-- 诊断（AI 节奏建议，对齐 mockup bento-action；待 core 补数据） -->
        <div class="bento-card bento-action">
          <div class="bc-label">诊断</div>
          <div class="rhythm-diag">AI 节奏诊断待 core 补充（字数异常章 · 钩子强弱 · 情绪连续性建议）。</div>
        </div>
        <!-- 钩子类型 × 强弱（长篇）-->
        <template v-if="data.kind === 'long'">
          <div v-if="hookTypeOption" class="bento-card bento-c2"><EChart :option="hookTypeOption" /></div>
          <div v-if="hookLevelOption" class="bento-card bento-c2"><EChart :option="hookLevelOption" /></div>
          <div v-if="sceneOption" class="bento-card bento-c2"><EChart :option="sceneOption" /></div>
          <div v-if="sceneEmotionOption" class="bento-card bento-c2"><EChart :option="sceneEmotionOption" /></div>
        </template>
        <!-- 情绪分布 -->
        <div v-if="emotionOption" class="bento-card bento-c2"><EChart :option="emotionOption" /></div>
        <!-- 核心反转（短篇）-->
        <div v-if="data.kind === 'short' && data.reversals.length" class="bento-card bento-full">
          <div class="bc-label">核心反转<span style="color:var(--text-3);font-weight:normal;text-transform:none;letter-spacing:0"> · 点篇名进篇详情</span></div>
          <RouterLink
            v-for="r in data.reversals"
            :key="r.篇号"
            class="bc-list-row rev-link"
            :to="`/books/${enc}/piece/${r.篇号}`"
          >
            <span>第 {{ r.篇号 }} 篇 · {{ r.标题 }}</span>
            <span class="lr-sub">{{ r.核心反转 }}</span>
          </RouterLink>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.rhythm-page{margin:0 auto}
.rhythm-page .bento-grid{grid-auto-rows:auto}
.rhythm-page .bento-card{min-height:116px}
.rhythm-page :deep(.echart){height:200px}
.rhythm-page .avg-line{margin:8px 0 0;text-align:center;font-size:12px;color:var(--text-3)}
.rhythm-page .rhythm-diag{font-size:12.5px;color:var(--text-2);line-height:1.8;margin-top:8px}
.rhythm-page .rev-link{text-decoration:none;color:inherit}
.rhythm-page .rev-link:hover{color:var(--ink-cyan)}
.rhythm-page .hint{color:var(--text-2);padding-top:24px}
.rhythm-page .hint.error{color:var(--cinnabar)}
</style>
