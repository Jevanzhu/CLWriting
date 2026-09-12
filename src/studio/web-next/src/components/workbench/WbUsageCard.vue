<script setup lang="ts">
// D1（批 4）AI 用量卡片：消费既有 GET /trace-stats（aggregateTrace 的 byTask 聚合——
// 此前端连 API 都引了没渲染，本卡补上渲染面）+ D2 的 cost-stats（配价书显示金额，
// 未配价显示引导不显示 0）。自取数（挂载即拉），WorkbenchView 单点挂载零数据编排。
import { computed, onMounted, onBeforeUnmount, ref, watch } from 'vue'
import { Gauge } from 'lucide-vue-next'
import { getCostStats, type CostStats } from '../../api/cost-stats'
import { useTraceStatsStore } from '../../stores/trace-stats'

const props = defineProps<{ bookName: string }>()

// R0912-FE-P3-4：trace-stats 改走共享 store——与 WorkbenchView.loadRuleHits 同屏各拉
// 一次 GET /trace-stats 的双发面在 store 层单点分发（同书并发去重）；本卡的
// getCostStats 仍自拉（仅本卡消费），取数/失败/切书代守卫口径不变。
const traceStats = useTraceStatsStore()

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
// R0912-3 #19：cost 取数失败与未配价（enabled:false）分流——此前 catch 吞成 null，
// 失败被渲染成「未配置价格表」引导，误导归因到配置
const costFailed = ref(false)
const loaded = ref(false)

/** R0912-3 #19：cost 取数失败不打穿整卡（trace-stats 仍要渲染），失败单独记态 */
async function loadCost(book: string): Promise<CostStats | 'failed'> {
  try {
    return await getCostStats(book)
  } catch {
    return 'failed'
  }
}

// 切书竞态代数（同 stores/ 的 opGen 模式）：旧书慢响应不回填新书数据
let loadGen = 0

// R1010b-FTC-P3-2（2026-09-10 内存专项重审修复批）：卸载 armed 单门——loadGen 代只挡
// 在途切书（实例复用），挡不住「请求在途实例卸载」（切路由整树销毁）：迟到的取数续体
// 此前照旧写回死实例 byTask/total/cost（低敏写回，非泄漏级）。对齐 style 系 armed /
// SettingsBookAnalysis 书名复检的「await 后守卫」纪律：高敏路径书名复检、低敏路径
// armed 单门。
let armed = true
onBeforeUnmount(() => {
  armed = false
})

async function load(): Promise<void> {
  const gen = ++loadGen
  loaded.value = false
  try {
    const [trace, costR] = await Promise.all([
      traceStats.getStats(props.bookName),
      loadCost(props.bookName),
    ])
    if (gen !== loadGen) return
    if (!armed) return // R1010b-FTC-P3-2：卸载后不写回死实例
    byTask.value = (trace.byTask ?? {}) as Record<string, TaskStat>
    total.value = trace.total ?? 0
    costFailed.value = costR === 'failed' // R0912-3 #19
    cost.value = costR === 'failed' ? null : costR
  } catch {
    // 离线/无数据：空态展示。失败也要清旧书数据（gen 匹配 = 本次请求属于当前书）——
    // 否则新书请求失败时 finally 置 loaded，旧书的调用量/金额挂在新书名下（敏感数据错位
    // 在失败路径复现，正是本卡要消灭的场景）
    if (gen !== loadGen) return
    if (!armed) return // R1010b-FTC-P3-2：失败路径同门
    byTask.value = {}
    total.value = 0
    cost.value = null
    costFailed.value = false // R0912-3 #19：整卡失败走空态，不误报 cost 取数失败
  } finally {
    if (gen === loadGen && armed) loaded.value = true
  }
}

onMounted(() => void load())
// Y-P2-3 同类：切书组件实例复用（WorkbenchView 不加 :key），此前仅挂载拉一次，
// 旧书的调用量/金额会残留挂在新书工作台——金额属敏感数据错位
watch(() => props.bookName, () => void load())

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
      <!-- D2（批 5）：配价书显示金额；未配价引导配置（不显示 0）。R0912-3 #19：
           取数失败单独成态，不再伪装成「未配置价格表」引导 -->
      <div v-if="cost?.enabled" class="usage-cost">
        本书累计成本 <strong>{{ cost.total.toFixed(4) }}</strong> {{ cost.currency ?? 'USD' }}
        <span v-if="Object.keys(cost.byChapter).length > 0" class="usage-cost-meta">
          （{{ Object.keys(cost.byChapter).length }} 个章节有记账）
        </span>
      </div>
      <div v-else-if="costFailed" class="usage-cost usage-cost--muted">
        成本金额取数失败（服务暂不可达），刷新后重试。
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
