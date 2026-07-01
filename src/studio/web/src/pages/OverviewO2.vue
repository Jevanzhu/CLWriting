<script setup lang="ts">
// o2 字数统计（总览子页面）：各章字数柱图（带均字参考线）+ 目标/平均/异常 + 各章明细（点跳编辑）。
// 数据 getRhythm（wordCurve）+ getOverview（targetWords）。均字自算（长短篇通用，rhythm.avgWords 仅长篇有）。
import { ref, watch, computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import EChart from '../components/EChart.vue'
import ErrorState from '../components/ErrorState.vue'
import type { EChartsOption, BarSeriesOption } from 'echarts'
import type { Rhythm, BookOverview } from '../types'
import { getRhythm, getOverview } from '../api/books'

const route = useRoute()
const router = useRouter()
const name = computed(() => (typeof route.params.name === 'string' ? route.params.name : ''))
const enc = computed(() => encodeURIComponent(name.value))
const rhythm = ref<Rhythm | null>(null)
const ov = ref<BookOverview | null>(null)
const loading = ref(true)
const error = ref('')

async function load(n: string): Promise<void> {
  loading.value = true
  error.value = ''
  rhythm.value = null
  ov.value = null
  try {
    ;[rhythm.value, ov.value] = await Promise.all([getRhythm(n), getOverview(n)])
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

const isLong = computed(() => rhythm.value?.kind === 'long')
const unit = computed(() => (isLong.value ? '章' : '篇'))

/** 均字（自算，长短篇通用） */
const avg = computed(() => {
  const d = rhythm.value
  if (!d || d.wordCurve.length === 0) return 0
  return Math.round(d.wordCurve.reduce((s, p) => s + p.字数, 0) / d.wordCurve.length)
})

/** 各章字数柱图（带均字参考线） */
const barOption = computed<EChartsOption | null>(() => {
  const d = rhythm.value
  if (!d || d.wordCurve.length === 0) return null
  const series: BarSeriesOption[] = [
    {
      type: 'bar',
      data: d.wordCurve.map((p) => p.字数),
      itemStyle: { color: 'var(--ink-cyan)', borderRadius: [4, 4, 0, 0] },
      markLine: {
        silent: true,
        symbol: 'none',
        data: [{ yAxis: avg.value, name: '均字', label: { formatter: '均字', position: 'insideEndTop' } }],
        lineStyle: { color: 'var(--ochre)', type: 'dashed' },
      },
    },
  ]
  return {
    tooltip: { trigger: 'axis' },
    grid: { left: 56, right: 24, top: 24, bottom: 36 },
    xAxis: { type: 'category', data: d.wordCurve.map((p) => `${'章号' in p ? p.章号 : p.篇号}`), name: unit.value },
    yAxis: { type: 'value', name: '字数' },
    series,
  }
})

/** 异常：偏离均字 >50%（过短/过长） */
const abnormalCount = computed(() => {
  const d = rhythm.value
  if (!d || d.wordCurve.length === 0 || avg.value === 0) return 0
  return d.wordCurve.filter((p) => p.字数 < avg.value * 0.5 || p.字数 > avg.value * 1.5).length
})

const target = computed(() => ov.value?.progress.targetWords)

function fmtWords(n: number): string {
  if (n <= 0) return '0'
  return n < 10000 ? `${n}` : `${(n / 10000).toFixed(1)} 万`
}

function goEdit(no: number): void {
  router.push(`/books/${enc.value}/edit?chapter=${no}`)
}

function chNo(p: { 章号: number } | { 篇号: number }): number {
  return '章号' in p ? p.章号 : p.篇号
}
</script>

<template>
  <section class="ov-page">
    <div class="bento-wrap">
      <div class="bento-head">
        <h1 class="bento-title">字数统计</h1>
        <div class="bento-sub">
          <span class="meta-chip">各{{ unit }}字数分布</span>
          <span v-if="rhythm" class="meta-chip">共 {{ rhythm.wordCurve.length }} {{ unit }}</span>
        </div>
      </div>
      <p v-if="loading" class="hint">加载中…</p>
      <ErrorState v-else-if="error" :msg="error" @retry="load(name)" />
      <div v-else-if="rhythm" class="bento-grid">
        <div v-if="barOption" class="bento-card bento-full">
          <div class="bc-label">各{{ unit }}字数</div>
          <EChart :option="barOption" />
        </div>
        <div class="bento-card">
          <div class="bc-menu">⋮</div>
          <div class="bc-label">目标</div>
          <div class="bc-stat">{{ target ? fmtWords(target) : '—' }}</div>
        </div>
        <div class="bento-card">
          <div class="bc-menu">⋮</div>
          <div class="bc-label">平均/{{ unit }}</div>
          <div class="bc-stat">{{ avg }}</div>
        </div>
        <div class="bento-card">
          <div class="bc-menu">⋮</div>
          <div class="bc-label">异常{{ unit }}</div>
          <div class="bc-stat" :style="{ color: abnormalCount ? 'var(--cinnabar)' : 'var(--text-3)' }">
            {{ abnormalCount }}
          </div>
        </div>
        <!-- 各章明细（点跳编辑） -->
        <div class="bento-card bento-full scroll ch-scroll">
          <div class="bc-label">
            各{{ unit }}明细
            <span class="bc-hint">· 点跳编辑 · 红=过短 / 赭=过长</span>
          </div>
          <div class="ch-list">
            <div
              v-for="p in rhythm.wordCurve"
              :key="chNo(p)"
              class="ch-row"
              @click="goEdit(chNo(p))"
            >
              <span class="ch-no">第 {{ chNo(p) }} {{ unit }}</span>
              <span class="ch-title">{{ p.标题 }}</span>
              <span
                class="ch-words"
                :class="{
                  low: avg > 0 && p.字数 < avg * 0.5,
                  high: avg > 0 && p.字数 > avg * 1.5,
                }"
              >{{ p.字数 }} 字</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.ov-page {
  margin: 0 auto;
}
.ov-page :deep(.echart) {
  height: 240px;
}
.ov-page .hint {
  color: var(--text-2);
  padding-top: 24px;
}
.ov-page .bc-hint {
  color: var(--text-3);
  font-weight: normal;
  text-transform: none;
  letter-spacing: 0;
}
.ov-page .ch-scroll {
  max-height: 320px;
}
.ov-page .ch-list {
  display: flex;
  flex-direction: column;
  padding: 4px 0;
}
.ov-page .ch-row {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 10px;
  border-radius: 8px;
  cursor: pointer;
  font-size: 13px;
}
.ov-page .ch-row:hover {
  background: var(--flat-hover);
}
.ov-page .ch-no {
  flex-shrink: 0;
  color: var(--text-3);
  width: 64px;
}
.ov-page .ch-title {
  flex: 1;
  color: var(--ink);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ov-page .ch-words {
  flex-shrink: 0;
  color: var(--text-2);
}
.ov-page .ch-words.low {
  color: var(--cinnabar);
}
.ov-page .ch-words.high {
  color: var(--ochre);
}
</style>
