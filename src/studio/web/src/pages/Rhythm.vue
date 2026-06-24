<script setup lang="ts">
import { ref, watch, computed } from 'vue'
import { useRoute } from 'vue-router'
import BookTabs from '../components/BookTabs.vue'
import EChart from '../components/EChart.vue'
import type { EChartsOption, BarSeriesOption, LineSeriesOption } from 'echarts'

interface RhythmLong {
  kind: 'long'
  wordCurve: { 章号: number; 标题: string; 字数: number }[]
  avgWords: number
  hookTypeDist: Record<string, number>
  hookLevelDist: Record<string, number>
  emotionDist: Record<string, number>
}
interface RhythmShort {
  kind: 'short'
  wordCurve: { 篇号: number; 标题: string; 字数: number }[]
  emotionDist: Record<string, number>
  reversals: { 篇号: number; 标题: string; 核心反转: string }[]
}
type Rhythm = RhythmLong | RhythmShort

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
    const r = await fetch(`/api/books/${encodeURIComponent(n)}/rhythm`)
    if (!r.ok) {
      const e = (await r.json().catch(() => ({}))) as { error?: string }
      throw new Error(e.error ?? `HTTP ${r.status}`)
    }
    data.value = (await r.json()) as Rhythm
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
      itemStyle: { color: '#3b82f6' },
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
      itemStyle: { color: '#6366f1', borderRadius: [4, 4, 0, 0] },
      label: { show: true, position: 'top' },
    },
  ]
  return {
    title: { text: title, left: 'center', textStyle: { fontSize: 13, fontWeight: 600, color: '#374151' } },
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
</script>

<template>
  <section class="rhythm-page">
    <BookTabs :name="name" active="rhythm" />

    <p v-if="loading" class="hint">加载中…</p>
    <p v-else-if="error" class="hint error">加载失败:{{ error }}</p>
    <template v-else-if="data">
      <!-- 字数曲线 -->
      <article class="card">
        <h3 class="block-title">{{ data.kind === 'long' ? '章长曲线' : '篇长曲线' }}</h3>
        <EChart v-if="wordOption" :option="wordOption" />
        <p v-if="data.kind === 'long'" class="avg-line">虚线为均字 {{ data.avgWords }}</p>
      </article>

      <!-- 钩子类型 × 强弱(长篇) -->
      <div v-if="data.kind === 'long'" class="grid-2">
        <article class="card"><EChart v-if="hookTypeOption" :option="hookTypeOption" /></article>
        <article class="card"><EChart v-if="hookLevelOption" :option="hookLevelOption" /></article>
      </div>

      <!-- 情绪分布 -->
      <article class="card"><EChart v-if="emotionOption" :option="emotionOption" /></article>

      <!-- 场景占位(长篇) -->
      <article v-if="data.kind === 'long'" class="card placeholder-card">
        <h3 class="block-title">场景分布</h3>
        <p class="hint">正文 ChapterMeta 无场景字段;需细纲数据(定稿书细纲已归档),后续接入。</p>
      </article>

      <!-- 核心反转(短篇) -->
      <article v-if="data.kind === 'short' && data.reversals.length" class="card">
        <h3 class="block-title">核心反转<span class="block-tip">（点篇名进篇详情）</span></h3>
        <ul class="rev-list">
          <li v-for="r in data.reversals" :key="r.篇号">
            <RouterLink class="rev-link" :to="`/books/${enc}/piece/${r.篇号}`">
              <span class="rev-no">第 {{ r.篇号 }} 篇 · {{ r.标题 }} →</span>
              <span class="rev-text">{{ r.核心反转 }}</span>
            </RouterLink>
          </li>
        </ul>
      </article>
    </template>
  </section>
</template>

<style scoped>
.rhythm-page {
  max-width: 960px;
  margin: 0 auto;
}
.card {
  background: #fff;
  border: 1px solid #e5e7eb;
  border-radius: 8px;
  padding: 16px 20px;
}
.card + .card,
.card + .grid-2,
.grid-2 + .card {
  margin-top: 16px;
}
.grid-2 {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 16px;
}
.block-title {
  margin: 0 0 8px;
  font-size: 13px;
  font-weight: 600;
  color: #6b7280;
  letter-spacing: 0.04em;
}
.avg-line {
  margin: 8px 0 0;
  text-align: center;
  font-size: 12px;
  color: #9ca3af;
}
.placeholder-card {
  background: #f9fafb;
}
.hint {
  color: #6b7280;
}
.hint.error {
  color: #dc2626;
}
.rev-list {
  margin: 0;
  padding: 0;
  list-style: none;
  display: grid;
  gap: 10px;
}
.rev-list li {
  padding: 10px 12px;
  background: #f9fafb;
  border-radius: 6px;
  display: grid;
  gap: 4px;
}
.rev-no {
  font-size: 13px;
  color: #6b7280;
}
.rev-text {
  font-size: 14px;
  color: #111827;
}
.block-tip {
  font-weight: normal;
  color: #9ca3af;
  font-size: 12px;
  margin-left: 6px;
}
.rev-link {
  display: block;
  text-decoration: none;
  color: inherit;
}
.rev-link:hover .rev-no {
  color: #3b82f6;
}
</style>
