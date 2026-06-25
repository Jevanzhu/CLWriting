<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import { useRoute } from 'vue-router'
import type { EChartsOption, LineSeriesOption } from 'echarts'
import EChart from '../components/EChart.vue'
import type { MetricsReport, StyleTrend } from '../types'
import { getHealth } from '../api/books'

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
    const r = await getHealth(n)
    metrics.value = r.metrics
    style.value = r.style
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
        itemStyle: { color: 'var(--ink-cyan)' },
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
        itemStyle: { color: 'var(--ochre)' },
      },
    ],
  }
})

function lineOption(title: string, data: number[], baselineVal?: number): EChartsOption {
  const series: LineSeriesOption[] = [
    { type: 'line', data, smooth: true, symbol: 'circle', symbolSize: 5, itemStyle: { color: 'var(--ink-cyan)' } },
  ]
  if (baselineVal !== undefined) {
    series.push({
      type: 'line',
      data: nums.value.map(() => baselineVal),
      name: '基线',
      lineStyle: { type: 'dashed', color: 'var(--text-3)' },
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
    <div class="panel-pad">
      <div class="panel-title">体检</div>
      <div class="panel-sub">成本 · 审查 · 文风漂移</div>

      <p v-if="loading" class="hint">加载中…</p>
      <p v-else-if="error" class="hint error">加载失败：{{ error }}</p>
      <template v-else>
        <!-- 成本 / 审查 -->
        <template v-if="metrics && metrics.count > 0">
          <div class="blk-label">成本 / 审查（{{ metrics.count }} {{ metrics.kind === 'short' ? '篇' : '章' }}）</div>
          <div class="card-row" style="grid-template-columns:repeat(5,1fr)">
            <div class="stat-card"><div class="n">{{ metrics.cost.avgCalls.toFixed(1) }}</div><div class="l">平均调用</div></div>
            <div class="stat-card"><div class="n">{{ metrics.cost.overLimitChapters }}</div><div class="l">超上限</div></div>
            <div class="stat-card"><div class="n">{{ pct(metrics.review.fullRate) }}</div><div class="l">满审率</div></div>
            <div class="stat-card"><div class="n">{{ pct(metrics.review.downgradeRate) }}</div><div class="l">降级率</div></div>
            <div class="stat-card"><div class="n">{{ metrics.review.avgBlockers.toFixed(1) }}</div><div class="l">平均阻断</div></div>
          </div>
          <div v-if="costBar" class="card"><div class="card-title">各阶段平均调用</div><EChart :option="costBar" /></div>
          <div class="card">
            <div class="card-title">预算 / 记账</div>
            <div class="kv"><span class="k">预算</span><span class="v">{{ metrics.cost.calibration.budgetNote }}</span></div>
            <div v-if="metrics.cost.calibration.accountingNote" class="kv">
              <span class="k">记账</span><span class="v ochre">{{ metrics.cost.calibration.accountingNote }}</span>
            </div>
            <div class="kv"><span class="k">tokens</span><span class="v">{{ metrics.cost.tokensNote }}</span></div>
          </div>
          <div v-if="reviewBar" class="card">
            <div class="card-title">降级原因 Top</div>
            <EChart :option="reviewBar" />
          </div>
        </template>
        <p v-else class="hint">尚无定稿指标。写完一章/篇定稿后可见成本与审查。</p>

        <!-- 文风 -->
        <template v-if="style && style.count > 0">
          <div class="blk-label">文风（{{ style.count }} {{ style.kind === 'short' ? '篇' : '章' }}）</div>
          <div v-if="tagLine" class="card"><EChart :option="tagLine" /></div>
          <div v-if="varLine" class="card"><EChart :option="varLine" /></div>
          <div v-if="repeatLine" class="card"><EChart :option="repeatLine" /></div>
          <div class="card">
            <div class="card-title">风险章节</div>
            <div class="kv"><span class="k">单句超限</span><span class="v">{{ style.overlongChapters.join('、') || '无' }}</span></div>
            <div class="kv"><span class="k">形容词堆叠</span><span class="v">{{ style.adjStackChapters.join('、') || '无' }}</span></div>
            <div class="kv"><span class="k">结尾总结体</span><span class="v">{{ style.summaryEndingChapters.join('、') || '无' }}</span></div>
          </div>
          <div v-if="style.drifts.length > 0" class="card">
            <div class="card-title">⚠ 漂移信号<span style="color:var(--text-3);font-weight:normal"> · 建议复核，非判决</span></div>
            <div v-for="d in style.drifts" :key="d.metric" class="list-row" style="margin-bottom:6px;align-items:flex-start">
              <span class="clw-dot yellow" style="margin-top:6px"></span>
              <div style="flex:1"><div class="m">{{ d.message }}</div></div>
            </div>
          </div>
        </template>
      </template>
    </div>
  </section>
</template>

<style scoped>
.health {
  margin: 0 auto;
}
.blk-label {
  font-size: 13px;
  font-weight: 600;
  color: var(--ink);
  margin: 24px 0 12px;
}
.blk-label:first-of-type {
  margin-top: 0;
}
.health :deep(.echart) {
  height: 200px;
}
.health .hint {
  color: var(--text-2);
  padding-top: 24px;
}
.health .hint.error {
  color: var(--cinnabar);
}
</style>
