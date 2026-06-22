<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import { useRoute } from 'vue-router'
import type { EChartsOption, LineSeriesOption } from 'echarts'
import EChart from '../components/EChart.vue'
import BookTabs from '../components/BookTabs.vue'

interface MetricsReport {
  count: number
  kind: string
  range: { from: number; to: number } | null
  cost: {
    avgCalls: number
    overLimitChapters: number
    tokensNote: string
    avgByStep: { outline: number; draft: number; review: number }
    calibration: { budgetNote: string; accountingNote: string | null }
  }
  review: {
    fullRate: number
    downgradeRate: number
    avgBlockers: number
    topDowngradeReasons: { reason: string; n: number }[]
    lensCoverage: Record<string, number>
    reviewedCount: number
  }
}
interface StyleTrend {
  kind: string
  count: number
  samples: { num: number; title: string }[]
  dialogueTagSeries: number[]
  varianceSeries: number[]
  repeatSeries: number[]
  overlongChapters: number[]
  adjStackChapters: number[]
  summaryEndingChapters: number[]
  drifts: { metric: string; message: string }[]
  baseline: { overall: { dialogueTagRatio: number; sentenceLenVariance: number; repeatRate: number } } | null
}

const route = useRoute()
const name = computed(() => (typeof route.params.name === 'string' ? route.params.name : ''))
const metrics = ref<MetricsReport | null>(null)
const style = ref<StyleTrend | null>(null)
const loading = ref(true)
const error = ref('')

async function load(n: string): Promise<void> {
  loading.value = true
  error.value = ''
  try {
    const enc = encodeURIComponent(n)
    const [m, s] = await Promise.all([
      fetch(`/api/books/${enc}/health/metrics`).then((r) => r.json() as Promise<MetricsReport>),
      fetch(`/api/books/${enc}/health/style`).then((r) => r.json() as Promise<StyleTrend>),
    ])
    metrics.value = m
    style.value = s
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

const nums = computed(() => style.value?.samples.map((s) => s.num) ?? [])

const costBar = computed<EChartsOption | null>(() => {
  const m = metrics.value
  if (!m || m.count === 0) return null
  return {
    tooltip: {},
    xAxis: { type: 'category', data: ['大纲', '草稿', '审查'] },
    yAxis: { type: 'value', name: '平均调用' },
    series: [
      {
        type: 'bar',
        data: [m.cost.avgByStep.outline, m.cost.avgByStep.draft, m.cost.avgByStep.review],
        itemStyle: { color: '#3b82f6' },
      },
    ],
  }
})

const reviewBar = computed<EChartsOption | null>(() => {
  const m = metrics.value
  if (!m || m.review.topDowngradeReasons.length === 0) return null
  return {
    tooltip: {},
    xAxis: { type: 'value' },
    yAxis: { type: 'category', data: m.review.topDowngradeReasons.map((r) => r.reason) },
    series: [
      {
        type: 'bar',
        data: m.review.topDowngradeReasons.map((r) => r.n),
        itemStyle: { color: '#f59e0b' },
      },
    ],
  }
})

function lineOption(title: string, data: number[], baselineVal?: number): EChartsOption {
  const series: LineSeriesOption[] = [
    { type: 'line', data, smooth: true, symbol: 'circle', symbolSize: 5, itemStyle: { color: '#10b981' } },
  ]
  if (baselineVal !== undefined) {
    series.push({
      type: 'line',
      data: nums.value.map(() => baselineVal),
      name: '基线',
      lineStyle: { type: 'dashed', color: '#9ca3af' },
      symbol: 'none',
    })
  }
  return {
    title: { text: title, left: 'center', textStyle: { fontSize: 13, fontWeight: 'normal' } },
    tooltip: { trigger: 'axis' },
    grid: { top: 36, bottom: 24, left: 44, right: 16 },
    xAxis: { type: 'category', data: nums.value.map(String) },
    yAxis: { type: 'value', scale: true },
    series,
  }
}

const tagLine = computed<EChartsOption | null>(() => {
  const s = style.value
  if (!s || s.count === 0) return null
  return lineOption('对话标签占比', s.dialogueTagSeries, s.baseline?.overall.dialogueTagRatio)
})
const varLine = computed<EChartsOption | null>(() => {
  const s = style.value
  if (!s || s.count === 0) return null
  return lineOption('句长方差', s.varianceSeries, s.baseline?.overall.sentenceLenVariance)
})
const repeatLine = computed<EChartsOption | null>(() => {
  const s = style.value
  if (!s || s.count === 0) return null
  return lineOption('复读率', s.repeatSeries, s.baseline?.overall.repeatRate)
})

function pct(x: number): string {
  return (x * 100).toFixed(0) + '%'
}
</script>

<template>
  <section class="health">
    <BookTabs :name="name" active="health" />
    <h2>体检</h2>

    <p v-if="loading" class="hint">加载中…</p>
    <p v-else-if="error" class="hint error">加载失败：{{ error }}</p>
    <template v-else>
      <section v-if="metrics && metrics.count > 0" class="block">
        <h3>成本 / 审查（{{ metrics.count }} {{ metrics.kind === 'short' ? '篇' : '章' }}）</h3>
        <div class="cards">
          <div class="card"><div class="k">平均调用</div><div class="v">{{ metrics.cost.avgCalls.toFixed(1) }}</div></div>
          <div class="card"><div class="k">超上限</div><div class="v">{{ metrics.cost.overLimitChapters }}</div></div>
          <div class="card"><div class="k">满审率</div><div class="v">{{ pct(metrics.review.fullRate) }}</div></div>
          <div class="card"><div class="k">降级率</div><div class="v">{{ pct(metrics.review.downgradeRate) }}</div></div>
          <div class="card"><div class="k">平均阻断</div><div class="v">{{ metrics.review.avgBlockers.toFixed(1) }}</div></div>
        </div>
        <EChart v-if="costBar" :option="costBar" />
        <p class="note">预算：{{ metrics.cost.calibration.budgetNote }}</p>
        <p v-if="metrics.cost.calibration.accountingNote" class="note warn">
          记账：{{ metrics.cost.calibration.accountingNote }}
        </p>
        <div v-if="reviewBar" class="sub">
          <h4>降级原因 Top</h4>
          <EChart :option="reviewBar" />
        </div>
      </section>
      <p v-else class="hint">尚无定稿指标。写完一章/篇定稿后可见成本与审查。</p>

      <section v-if="style && style.count > 0" class="block">
        <h3>文风（{{ style.count }} {{ style.kind === 'short' ? '篇' : '章' }}）</h3>
        <div class="style-charts">
          <EChart v-if="tagLine" :option="tagLine" />
          <EChart v-if="varLine" :option="varLine" />
          <EChart v-if="repeatLine" :option="repeatLine" />
        </div>
        <div class="risk">
          <span>单句超限：{{ style.overlongChapters.join('、') || '无' }}</span>
          <span>形容词堆叠：{{ style.adjStackChapters.join('、') || '无' }}</span>
          <span>结尾总结体：{{ style.summaryEndingChapters.join('、') || '无' }}</span>
        </div>
        <div v-if="style.drifts.length > 0" class="drifts">
          <h4>⚠ 漂移信号（建议复核，非判决）</h4>
          <p v-for="d in style.drifts" :key="d.metric" class="warn">· {{ d.message }}</p>
        </div>
      </section>
      <p v-else class="hint">尚无已定稿正文可重扫文风。</p>
    </template>
  </section>
</template>

<style scoped>
.health {
  max-width: 960px;
  margin: 0 auto;
}
.health h2 {
  margin: 12px 0;
  font-size: 16px;
}
.block {
  background: #fff;
  border: 1px solid #e5e7eb;
  border-radius: 8px;
  padding: 20px;
  margin-bottom: 16px;
}
.block h3 {
  margin: 0 0 16px;
  font-size: 15px;
}
.cards {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  margin-bottom: 16px;
}
.card {
  background: #f9fafb;
  border-radius: 6px;
  padding: 10px 16px;
  min-width: 92px;
}
.card .k {
  color: #6b7280;
  font-size: 12px;
}
.card .v {
  font-size: 20px;
  font-weight: 600;
  margin-top: 2px;
}
.note {
  color: #6b7280;
  font-size: 13px;
  margin: 8px 0 0;
}
.note.warn {
  color: #d97706;
}
.sub {
  margin-top: 16px;
}
.sub h4 {
  margin: 0 0 8px;
  font-size: 13px;
  color: #374151;
}
.style-charts {
  display: grid;
  gap: 12px;
}
.risk {
  display: flex;
  flex-wrap: wrap;
  gap: 16px;
  margin-top: 12px;
  font-size: 13px;
  color: #4b5563;
}
.drifts {
  margin-top: 12px;
}
.drifts h4 {
  margin: 0 0 6px;
  font-size: 13px;
  color: #d97706;
}
.warn {
  color: #d97706;
  font-size: 13px;
  margin: 2px 0;
}
.hint {
  color: #6b7280;
}
.hint.error {
  color: #dc2626;
}
</style>
