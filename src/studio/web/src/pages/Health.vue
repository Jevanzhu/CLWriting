<script setup lang="ts">
// 体检（总览 a_health）：Bento 便当盒网格，对齐 mockup v5。
// 数据 GET /health/metrics + /health/style（真实 MetricsReport + StyleTrend）。
import { ref, computed, watch } from 'vue'
import { useRoute } from 'vue-router'
import type { EChartsOption, LineSeriesOption } from 'echarts'
import EChart from '../components/EChart.vue'
import ErrorState from '../components/ErrorState.vue'
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

/** 综合健康分（满审率映射 0-100，三色编码：≥80 cyan / ≥60 ochre / 否则 cinnabar） */
const healthScore = computed(() => {
  const m = metrics.value
  if (!m || m.count === 0) return 0
  return Math.round(m.review.fullRate * 100)
})
const healthRingStyle = computed(() => {
  const s = healthScore.value
  const col = s >= 80 ? 'var(--ink-cyan)' : s >= 60 ? 'var(--ochre)' : 'var(--cinnabar)'
  return `background:conic-gradient(${col} 0 ${s}%,var(--border-55) ${s}% 100%)`
})

/** 各维度评分 ring 矩阵（对齐 mockup a_health bento-full；从 metrics 派生 % 维度） */
const dimRings = computed(() => {
  const m = metrics.value
  if (!m || m.count === 0) return []
  const overRate = m.cost.overLimitChapters / m.count
  return [
    { name: '满审', val: Math.round(m.review.fullRate * 100), tip: `${Math.round(m.review.fullRate * 100)}%` },
    { name: '通过', val: Math.round((1 - m.review.downgradeRate) * 100), tip: `${Math.round((1 - m.review.downgradeRate) * 100)}%` },
    { name: '成本合规', val: Math.round((1 - overRate) * 100), tip: `${m.cost.overLimitChapters} 章超限` },
    { name: '阻断控制', val: Math.max(0, 100 - Math.round(m.review.avgBlockers * 20)), tip: `均 ${m.review.avgBlockers.toFixed(1)} 阻断` },
  ]
})
</script>

<template>
  <section class="health">
    <div class="bento-wrap">
      <div class="bento-head">
        <h1 class="bento-title">体检</h1>
        <div class="bento-sub">
          <span class="meta-chip">成本</span>
          <span class="meta-chip">审查</span>
          <span class="meta-chip">文风漂移</span>
        </div>
      </div>

      <p v-if="loading" class="hint">加载中…</p>
      <ErrorState v-else-if="error" :msg="error" @retry="load(name)" />
      <template v-else>
        <!-- 成本 / 审查 -->
        <div v-if="metrics && metrics.count > 0" class="blk-label">成本 / 审查（{{ metrics.count }} {{ metrics.kind === 'short' ? '篇' : '章' }}）</div>
        <div v-if="metrics && metrics.count > 0" class="bento-grid">
          <div class="bento-card bento-lg">
            <div class="bc-menu" title="操作">⋮</div>
            <div class="bc-label">总体健康</div>
            <div class="bc-ring" :style="healthRingStyle"><span>{{ healthScore }}<span>%</span></span></div>
            <div class="bc-foot">{{ metrics.count }} {{ metrics.kind === 'short' ? '篇' : '章' }} · 满审 {{ pct(metrics.review.fullRate) }} · {{ style?.drifts.length ?? 0 }} 项漂移</div>
          </div>
          <div class="bento-card"><div class="bc-label">平均调用</div><div class="bc-stat">{{ metrics.cost.avgCalls.toFixed(1) }}</div></div>
          <div class="bento-card"><div class="bc-label">超上限</div><div class="bc-stat" style="color:var(--cinnabar)">{{ metrics.cost.overLimitChapters }}</div></div>
          <div class="bento-card"><div class="bc-label">满审率</div><div class="bc-stat" style="color:var(--ink-cyan)">{{ pct(metrics.review.fullRate) }}</div></div>
          <div class="bento-card"><div class="bc-label">降级率</div><div class="bc-stat" style="color:var(--ochre)">{{ pct(metrics.review.downgradeRate) }}</div></div>
          <div class="bento-card"><div class="bc-label">平均阻断</div><div class="bc-stat">{{ metrics.review.avgBlockers.toFixed(1) }}</div></div>
          <div v-if="dimRings.length" class="bento-card bento-full">
            <div class="bc-label">各维度评分</div>
            <div class="dim-grid">
              <div v-for="d in dimRings" :key="d.name" class="dim-cell">
                <div class="ring on-panel" :style="{ background: `conic-gradient(${d.val >= 80 ? 'var(--ink-cyan)' : d.val >= 60 ? 'var(--ochre)' : 'var(--cinnabar)'} 0 ${d.val}%, var(--border) ${d.val}% 100%)` }"><span class="ring-txt">{{ d.val }}</span></div>
                <div class="dim-name">{{ d.name }}</div>
                <div class="dim-count">{{ d.tip }}</div>
              </div>
            </div>
          </div>
          <div v-if="costBar" class="bento-card bento-c2"><div class="bc-label">各阶段平均调用</div><EChart :option="costBar" /></div>
          <div class="bento-card">
            <div class="bc-label">预算 / 记账</div>
            <div class="kv"><span class="k">预算</span><span class="v">{{ metrics.cost.calibration.budgetNote }}</span></div>
            <div v-if="metrics.cost.calibration.accountingNote" class="kv"><span class="k">记账</span><span class="v ochre">{{ metrics.cost.calibration.accountingNote }}</span></div>
            <div class="kv"><span class="k">tokens</span><span class="v">{{ metrics.cost.tokensNote }}</span></div>
          </div>
          <div v-if="reviewBar" class="bento-card bento-c2"><div class="bc-label">降级原因 Top</div><EChart :option="reviewBar" /></div>
        </div>
        <p v-else class="hint">尚无定稿指标。写完一章/篇定稿后可见成本与审查。</p>

        <!-- 文风 -->
        <div v-if="style && style.count > 0" class="blk-label">文风（{{ style.count }} {{ style.kind === 'short' ? '篇' : '章' }}）</div>
        <div v-if="style && style.count > 0" class="bento-grid">
          <div v-if="tagLine" class="bento-card bento-c2"><EChart :option="tagLine" /></div>
          <div v-if="varLine" class="bento-card bento-c2"><EChart :option="varLine" /></div>
          <div v-if="repeatLine" class="bento-card bento-full"><EChart :option="repeatLine" /></div>
          <div class="bento-card">
            <div class="bc-label">风险章节</div>
            <div class="kv"><span class="k">单句超限</span><span class="v">{{ style.overlongChapters.join('、') || '无' }}</span></div>
            <div class="kv"><span class="k">形容词堆叠</span><span class="v">{{ style.adjStackChapters.join('、') || '无' }}</span></div>
            <div class="kv"><span class="k">结尾总结体</span><span class="v">{{ style.summaryEndingChapters.join('、') || '无' }}</span></div>
          </div>
          <div v-if="style.drifts.length > 0" class="bento-card bento-c2">
            <div class="bc-label">⚠ 漂移信号<span style="color:var(--text-3);font-weight:normal;text-transform:none;letter-spacing:0"> · 建议复核，非判决</span></div>
            <div v-for="d in style.drifts" :key="d.metric" class="drift-row">
              <span class="clw-dot yellow"></span><span>{{ d.message }}</span>
            </div>
          </div>
        </div>
      </template>
    </div>
  </section>
</template>

<style scoped>
.health{margin:0 auto}
/* 图表页 bento 行高自适应（图表高度不一），最小 116px 保持卡感 */
.health .bento-grid{grid-auto-rows:auto}
.health .bento-card{min-height:116px}
.health .bento-card .kv{margin-top:2px}
.health :deep(.echart){height:180px}
.health .blk-label{font-size:13px;font-weight:600;color:var(--ink);margin:24px 0 12px}
.health .blk-label:first-of-type{margin-top:0}
.health .dim-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-top:12px}
.health .dim-cell{display:flex;flex-direction:column;align-items:center;gap:5px;padding:12px 8px;border-radius:12px;background:color-mix(in srgb,var(--panel) 38%,transparent)}
.health .dim-cell .ring{width:58px;height:58px}
.health .dim-cell .ring-txt{font-size:13px}
.health .dim-name{font-size:12px;color:var(--ink);font-weight:500}
.health .dim-count{font-size:10px;color:var(--text-3)}
.health .drift-row{display:flex;align-items:flex-start;gap:8px;padding:6px 0;font-size:12px;color:var(--text-2);line-height:1.6}
.health .drift-row .clw-dot{margin-top:6px;flex-shrink:0}
.health .hint{color:var(--text-2);padding-top:24px}
.health .hint.error{color:var(--cinnabar)}
</style>
