<script setup lang="ts">
// D1（批 4）AI 用量卡片：消费既有 GET /trace-stats（aggregateTrace 的 byTask 聚合——
// 此前端连 API 都引了没渲染，本卡补上渲染面）+ D2 的 cost-stats（配价书显示金额，
// 未配价显示引导不显示 0）。自取数（挂载即拉），WorkbenchView 单点挂载零数据编排。
import { computed, onMounted, ref } from 'vue'
import { Gauge } from 'lucide-vue-next'
import { getTraceStats } from '../../api/trace-stats'
import { getCostStats, type CostStats } from '../../api/cost-stats'

const props = defineProps<{ bookName: string }>()

interface TaskStat {
  count: number
  successRate: number
  avgAttempts: number
  durationP50: number
  durationP95: number
  totalInputTokens: number
  totalOutputTokens: number
  byDay: Record<string, { count: number; successRate: number; tokens: number }>
}

const byTask = ref<Record<string, TaskStat>>({})
const total = ref(0)
const cost = ref<CostStats | null>(null)
const loaded = ref(false)

onMounted(async () => {
  try {
    const [trace, costStats] = await Promise.all([
      getTraceStats(props.bookName),
      getCostStats(props.bookName).catch(() => null),
    ])
    byTask.value = (trace.byTask ?? {}) as Record<string, TaskStat>
    total.value = trace.total ?? 0
    cost.value = costStats
  } catch {
    /* 离线/无数据：空态展示 */
  } finally {
    loaded.value = true
  }
})

const tasks = computed(() =>
  Object.entries(byTask.value)
    .map(([task, s]) => ({
      task,
      count: s.count,
      tokens: s.totalInputTokens + s.totalOutputTokens,
      p50: s.durationP50,
      p95: s.durationP95,
      success: s.successRate,
    }))
    .sort((a, b) => b.count - a.count),
)

/** 按日趋势（跨任务聚合）：最近 14 天 sparkline 数据 */
const trend = computed(() => {
  const byDay: Record<string, number> = {}
  for (const s of Object.values(byTask.value)) {
    for (const [day, d] of Object.entries(s.byDay ?? {})) {
      byDay[day] = (byDay[day] ?? 0) + d.count
    }
  }
  return Object.keys(byDay).sort().slice(-14).map((day) => ({ day, count: byDay[day]! }))
})

const trendMax = computed(() => Math.max(1, ...trend.value.map((t) => t.count)))

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M'
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'k'
  return String(n)
}

function fmtMs(n: number): string {
  return n >= 1000 ? (n / 1000).toFixed(1) + 's' : Math.round(n) + 'ms'
}
</script>

<template>
  <section class="card usage-card">
    <div class="usage-head">
      <span class="usage-title"><Gauge :size="14" /> AI 用量</span>
      <span class="usage-total">{{ total }} 次调用</span>
    </div>

    <div v-if="!loaded" class="usage-empty">统计加载中…</div>
    <div v-else-if="tasks.length === 0" class="usage-empty">
      暂无 AI 调用记录（写作/审稿/摘要等任务的用量在此汇总）。
    </div>
    <template v-else>
      <!-- D2（批 5）：配价书显示金额；未配价引导配置（不显示 0） -->
      <div v-if="cost?.enabled" class="usage-cost">
        本书累计成本 <strong>{{ cost.total.toFixed(4) }}</strong> {{ cost.currency ?? 'USD' }}
        <span v-if="Object.keys(cost.byChapter).length > 0" class="usage-cost-meta">
          （{{ Object.keys(cost.byChapter).length }} 个章节有记账）
        </span>
      </div>
      <div v-else class="usage-cost usage-cost--muted">
        未配置价格表——在「设置 · 服务提供方」编辑价格后此处显示金额。
      </div>

      <table class="usage-table">
        <thead>
          <tr><th>任务</th><th>次数</th><th>tokens</th><th>P50 / P95</th><th>成功率</th></tr>
        </thead>
        <tbody>
          <tr v-for="t in tasks" :key="t.task">
            <td class="usage-task">{{ t.task }}</td>
            <td>{{ t.count }}</td>
            <td>{{ fmtTokens(t.tokens) }}</td>
            <td>{{ fmtMs(t.p50) }} / {{ fmtMs(t.p95) }}</td>
            <td :class="{ 'usage-warn': t.success < 0.8 }">{{ (t.success * 100).toFixed(0) }}%</td>
          </tr>
        </tbody>
      </table>

      <!-- 按日趋势 sparkline（条形，纯 CSS 不引图表库） -->
      <div v-if="trend.length > 1" class="usage-trend">
        <div
          v-for="t in trend"
          :key="t.day"
          class="usage-bar"
          :style="{ height: Math.max(8, (t.count / trendMax) * 100) + '%' }"
          :title="`${t.day}：${t.count} 次`"
        ></div>
      </div>
    </template>
  </section>
</template>

<style scoped>
.usage-card {
  display: flex;
  flex-direction: column;
  gap: var(--size-4-2);
}
.usage-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.usage-title {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: var(--font-size-xs);
  font-weight: 600;
  color: var(--text-muted);
  text-transform: uppercase;
  letter-spacing: 0.05em;
}
.usage-total {
  font-size: var(--font-size-xs);
  color: var(--text-faint);
}
.usage-empty {
  font-size: var(--font-size-s);
  color: var(--text-faint);
  line-height: 1.6;
}
.usage-cost {
  font-size: var(--font-size-s);
  color: var(--text-normal);
}
.usage-cost strong {
  color: var(--text-accent, inherit);
}
.usage-cost--muted {
  color: var(--text-faint);
  font-size: var(--font-size-xs);
}
.usage-cost-meta {
  color: var(--text-faint);
  font-size: var(--font-size-xs);
}
.usage-table {
  width: 100%;
  border-collapse: collapse;
  font-size: var(--font-size-s);
}
.usage-table th {
  text-align: left;
  font-weight: 500;
  color: var(--text-faint);
  font-size: var(--font-size-xs);
  padding: 3px 8px 3px 0;
  border-bottom: 1px solid var(--background-modifier-border);
}
.usage-table td {
  padding: 4px 8px 4px 0;
  border-bottom: 1px solid var(--background-modifier-border);
  color: var(--text-muted);
}
.usage-table td.usage-task {
  color: var(--text-normal);
  font-family: var(--font-monospace);
  font-size: var(--font-size-xs);
}
.usage-warn {
  color: var(--text-warning);
}
.usage-trend {
  display: flex;
  align-items: flex-end;
  gap: 3px;
  height: 36px;
}
.usage-bar {
  flex: 1;
  min-width: 4px;
  background: color-mix(in srgb, var(--interactive-accent) 45%, transparent);
  border-radius: 2px 2px 0 0;
}
</style>
