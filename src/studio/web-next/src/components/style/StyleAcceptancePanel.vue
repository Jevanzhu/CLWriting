<script setup lang="ts">
// 文风验收卡（StyleView 拆分 P2-5 ④ 验收段）：机检重扫 + AI 语义分析双块。
// 机检重扫零 AI；AI 语义分析耗 token 且完成时后端自动落源3候选。
import { computed, ref } from 'vue'
import { useRoute } from 'vue-router'
import { ClipboardCheck, RefreshCw, TriangleAlert } from 'lucide-vue-next'
import { useStyleStore } from '../../stores/style'
import { useUiStore } from '../../stores/ui'
import { runStyleAnalysis, type StylePayload } from '../../api/analysis'
import { friendlyError } from '../../shared/error'
import BetaBadge from '../ui/BetaBadge.vue'

const props = defineProps<{ bookName: string }>()
const route = useRoute()
const style = useStyleStore()
const ui = useUiStore()

const rescanning = ref(false)
async function onRescan(): Promise<void> {
  if (rescanning.value) return
  // R26-71（二十六轮）：书名入口捕获 + catch 复检（对齐下方 onAnalyze 的 M-4/R75-E-P3c
  // 模式）——重扫在途切书后本组件成死实例（props 冻结旧书），A 书的失败 toast 不落 B 书
  const book = props.bookName
  rescanning.value = true
  try {
    await style.rescan()
  } catch (e) {
    if (String(route.params.name ?? '') !== book) return
    ui.toast(friendlyError(e), 'error')
  } finally {
    rescanning.value = false
  }
}

const aiOff = computed(() => ui.aiAvailable === false)
const analyzing = ref(false)
const aiResult = ref<StylePayload | null>(null)
async function onAnalyze(): Promise<void> {
  if (analyzing.value) return
  // M-4（第十轮）：书名入口捕获 + await 后复检——分析可达 120s，期间切书时 StyleView
  // 挂 :key=bookName 整树重建，本死实例的 props 冻结在旧书（比 props 恒等），须比
  // 路由活书名：放行则死实例的 style.load(旧书) 把 A 书数据写进共享 store，B 书文风页
  // 从此显示 A 的数据、后续确认/忽略/收割全写向 A 书
  const book = props.bookName
  analyzing.value = true
  try {
    const r = await runStyleAnalysis(book)
    if (String(route.params.name ?? '') !== book) return
    aiResult.value = r.envelope.payload as StylePayload
    if (r.styleCandidates > 0) {
      await style.load(book)
      if (String(route.params.name ?? '') !== book) return
      ui.toast(`分析完成：口癖和建议已生成${r.styleCandidates}条候选`, 'success')
    } else {
      ui.toast('分析完成', 'success')
    }
  } catch (e) {
    // R75-E-P3c：catch 侧补同款书名复检——成功路径有门（上方两处），catch 漏配：
    // runStyleAnalysis await 窗口切书后，A 书的分析失败错误会 toast 在 B 书界面上
    if (String(route.params.name ?? '') !== book) return
    ui.toast(friendlyError(e), 'error')
  } finally {
    analyzing.value = false
  }
}

/** 序列 → sparkline 折线点（min-max 归一化到 viewBox 100×24，上留 2 下留 2） */
function sparkPoints(series: number[]): string {
  if (series.length === 0) return ''
  if (series.length === 1) return '0,12 100,12'
  const min = Math.min(...series)
  const max = Math.max(...series)
  const span = max - min || 1
  return series
    .map((v, i) => {
      const x = (i / (series.length - 1)) * 100
      const y = 22 - ((v - min) / span) * 20
      return `${x.toFixed(1)},${y.toFixed(1)}`
    })
    .join(' ')
}
const unit = computed(() => '章')
function avg(series: number[]): number {
  return series.length ? series.reduce((a, b) => a + b, 0) / series.length : 0
}
function fmtDate(iso: string): string {
  return iso.slice(0, 10)
}
</script>

<template>
  <section class="panel">
    <div class="panel-head">
      <ClipboardCheck :size="14" /> <span>验收 <BetaBadge /></span>
      <span class="head-note">写出去的东西还像不像你</span>
    </div>
    <div class="accept-grid">
      <!-- 机检重扫（零 AI） -->
      <div class="accept-block">
        <div class="ab-head">
          <span class="ab-title">规则检测</span>
          <span class="token-chip free">免费</span>
          <button class="btn-ghost" :disabled="rescanning" @click="onRescan">
            <RefreshCw :size="12" :class="{ spin: rescanning }" />
            {{ style.trend ? '重扫' : '扫描' }}
          </button>
        </div>
        <template v-if="style.trend && style.trend.count > 0">
          <div class="ab-meta">
            基于{{ style.trend.count }}{{ unit }}定稿 ·
            {{ style.trend.baseline ? `对照 ${fmtDate(style.trend.baseline.frozenAt)} 基准` : '无基准（仅检测当前值）' }}
          </div>
          <div class="spark-rows">
            <div class="spark-row">
              <span class="sr-label">对话标签占比</span>
              <svg class="spark" viewBox="0 0 100 24" preserveAspectRatio="none" role="img" aria-label="趋势图">
                <polyline :points="sparkPoints(style.trend.dialogueTagSeries)" />
              </svg>
              <span class="sr-val">均值{{ Math.round(avg(style.trend.dialogueTagSeries) * 100) }}%</span>
            </div>
            <div class="spark-row">
              <span class="sr-label">句长方差</span>
              <svg class="spark" viewBox="0 0 100 24" preserveAspectRatio="none" role="img" aria-label="趋势图">
                <polyline :points="sparkPoints(style.trend.varianceSeries)" />
              </svg>
              <span class="sr-val">均值{{ Math.round(avg(style.trend.varianceSeries)) }}</span>
            </div>
            <div class="spark-row">
              <span class="sr-label">复读率</span>
              <svg class="spark" viewBox="0 0 100 24" preserveAspectRatio="none" role="img" aria-label="趋势图">
                <polyline :points="sparkPoints(style.trend.repeatSeries)" />
              </svg>
              <span class="sr-val">均值{{ Math.round(avg(style.trend.repeatSeries) * 100) }}%</span>
            </div>
          </div>
          <div class="ab-stats">
            <span>单句超限 {{ style.trend.overlongChapters.length }}/{{ style.trend.count }}{{ unit }}</span>
            <span>堆叠命中 {{ style.trend.adjStackChapters.length }}{{ unit }}</span>
            <span>总结体结尾 {{ style.trend.summaryEndingChapters.length }}{{ unit }}</span>
          </div>
          <div v-if="style.trend.drifts.length > 0" class="drift-list">
            <div v-for="(d, i) in style.trend.drifts" :key="i" class="drift-item"><TriangleAlert :size="11" /> {{ d.message }}</div>
          </div>
          <div v-else class="ab-ok">未发现文风偏差</div>
        </template>
        <div v-else-if="style.trend" class="ab-empty">尚无定稿正文可扫</div>
        <div v-else class="ab-empty">点「扫描」按铁律标准检查全部定稿</div>
      </div>

      <!-- AI 语义分析（耗 token） -->
      <div class="accept-block">
        <div class="ab-head">
          <span class="ab-title">AI深度分析</span>
          <span class="token-chip cost">消耗额度</span>
          <button class="btn-ghost" :disabled="aiOff || analyzing" @click="onAnalyze">
            <RefreshCw :size="12" :class="{ spin: analyzing }" />
            {{ analyzing ? '分析中…' : '分析' }}
          </button>
        </div>
        <template v-if="aiResult">
          <div class="ai-drift">{{ aiResult.drift }}</div>
          <div v-if="aiResult.口癖?.length" class="ai-tags">
            <span v-for="(t, i) in aiResult.口癖" :key="i" class="ai-tag">{{ t }}</span>
          </div>
          <div v-if="aiResult.重复度评价" class="ai-line">{{ aiResult.重复度评价 }}</div>
          <div v-if="aiResult.建议?.length" class="ai-suggestions">
            <div v-for="(s, i) in aiResult.建议" :key="i" class="ai-suggestion">{{ s }}</div>
          </div>
        </template>
        <div v-else class="ab-empty">
          {{ aiOff ? 'AI暂不可用' : '读最近定稿做全书文风总结；口癖和建议会自动进候选箱' }}
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
/* ══ 面板基础（对齐 OverviewView 卡片语言）══ */
.panel {
  background: var(--background-primary);
  border: 1px solid var(--background-modifier-border);
  border-radius: var(--radius-l);
  padding: 18px 20px;
  animation: clw-fade-up var(--dur-fast) var(--ease-out) both;
}

/* ══ 通用按钮 ══ */
.btn-ghost {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: var(--font-size-xs);
  padding: 4px 10px;
  border-radius: var(--radius-s);
  cursor: pointer;
  border: 1px solid var(--background-modifier-border);
  background: transparent;
  color: var(--text-muted);
  white-space: nowrap;
}
.btn-ghost:hover:not(:disabled) {
  background: var(--background-modifier-hover);
  color: var(--text-normal);
}
.btn-ghost:disabled {
  opacity: 0.45;
  cursor: default;
}
.spin {
  animation: clw-spin 1s linear infinite;
}

/* ══ token 徽标（零 token / 耗 token 区分同名打架）══ */
.token-chip {
  font-size: var(--font-size-xxs);
  padding: 1px 7px;
  border-radius: 99px;
  font-weight: 600;
  letter-spacing: 0.02em;
}
.token-chip.free {
  color: var(--dv-good);
  background: color-mix(in srgb, var(--dv-good) 12%, transparent);
}
.token-chip.cost {
  color: var(--dv-warn);
  background: color-mix(in srgb, var(--dv-warn) 12%, transparent);
}

/* ══ ④ 验收 ══ */
.accept-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
}
@media (max-width: 860px) {
  .accept-grid {
    grid-template-columns: 1fr;
  }
}
.accept-block {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 12px 14px;
  border: 1px solid var(--background-modifier-border);
  border-radius: var(--radius-m);
  background: var(--background-secondary);
}
.ab-head {
  display: flex;
  align-items: center;
  gap: 8px;
}
.ab-title {
  font-size: var(--font-size-s);
  font-weight: 600;
  color: var(--text-normal);
}
.ab-head .btn-ghost {
  margin-left: auto;
}
.ab-meta {
  font-size: var(--font-size-xs);
  color: var(--text-faint);
}
.ab-empty {
  font-size: var(--font-size-xs);
  color: var(--text-faint);
  line-height: 1.6;
  padding: 6px 0;
}
.ab-ok {
  font-size: var(--font-size-xs);
  color: var(--dv-good);
}
.spark-rows {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.spark-row {
  display: flex;
  align-items: center;
  gap: 8px;
}
.sr-label {
  font-size: var(--font-size-xs);
  color: var(--text-muted);
  width: 84px;
  flex-shrink: 0;
}
.spark {
  flex: 1;
  height: 24px;
  min-width: 0;
}
.spark polyline {
  fill: none;
  stroke: var(--text-accent);
  stroke-width: 1.5;
  vector-effect: non-scaling-stroke;
}
.sr-val {
  font-size: var(--font-size-xs);
  color: var(--text-faint);
  width: 64px;
  text-align: right;
  flex-shrink: 0;
  font-variant-numeric: tabular-nums;
}
.ab-stats {
  display: flex;
  flex-wrap: wrap;
  gap: 6px 14px;
  font-size: var(--font-size-xs);
  color: var(--text-muted);
}
.drift-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.drift-item {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: var(--font-size-xs);
  color: var(--text-warning);
  line-height: 1.6;
}
.ai-drift {
  font-size: var(--font-size-s);
  color: var(--text-normal);
  line-height: 1.7;
}
.ai-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.ai-tag {
  font-size: var(--font-size-xs);
  color: var(--text-error);
  background: color-mix(in srgb, var(--text-error) 10%, transparent);
  border-radius: 99px;
  padding: 1px 9px;
}
.ai-line {
  font-size: var(--font-size-xs);
  color: var(--text-muted);
}
.ai-suggestions {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.ai-suggestion {
  font-size: var(--font-size-xs);
  color: var(--text-muted);
  line-height: 1.6;
  padding-left: 12px;
  position: relative;
}
.ai-suggestion::before {
  content: '·';
  position: absolute;
  left: 2px;
  color: var(--text-accent);
}

</style>
