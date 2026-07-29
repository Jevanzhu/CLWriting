<script setup lang="ts">
// 节奏视图（块4）：GET /rhythm 渲染 长篇双轨对比。
// 三区：字数曲线（已写波动）+ 节奏分布（written/planned 双条）+ 章纲覆盖（规划/已写/待写/达成率）。
// 短篇无章纲节奏 → 占位。纯 SVG 可视化，无图表库。
import { ref, computed, onMounted } from 'vue'
import { RefreshCw, Sparkles, Activity, Anchor, Feather } from 'lucide-vue-next'
import { getRhythm, type RhythmLong, type RhythmDist } from '../api/rhythm'
import {
  getAnalysisOverview, runStyleAnalysis, runAnalyze,
  type AnalysisOverview,
} from '../api/analysis'
import { useUiStore } from '../stores/ui'

const props = defineProps<{ bookName: string }>()
const data = ref<RhythmLong | null>(null)
const isShort = ref(false)
const loading = ref(true)
const err = ref<string | null>(null)

async function load(): Promise<void> {
  loading.value = true
  err.value = null
  try {
    const r = await getRhythm(props.bookName)
    if (r.kind === 'long') {
      data.value = r
      isShort.value = false
    } else {
      data.value = null
      isShort.value = true
    }
  } catch (e) {
    err.value = e instanceof Error ? e.message : String(e)
  } finally {
    loading.value = false
  }
}
onMounted(() => {
  void load()
  void loadOverview()
})

// 枚举顺序与服务端 rhythm.ts 一致（稳定渲染）
const HOOK_TYPES = ['危机钩', '悬念钩', '渴望钩', '情绪钩', '选择钩']
const HOOK_LEVELS = ['强', '中', '弱']
const EMOTIONS = ['压抑', '铺垫', '小爽', '大爽', '转折']
const SCENE_TYPES = ['战斗', '对话', '抒情', '叙事铺陈', '爽点高潮']

const totalWrittenWords = computed(() =>
  (data.value?.wordCurve ?? []).reduce((s, p) => s + p.字数, 0),
)
const pendingChapters = computed(() => {
  const d = data.value
  return d ? Math.max(0, d.planned.count - d.written.count) : 0
})
const wordAchievement = computed(() => {
  const d = data.value
  if (!d || !d.planned.targetWords) return 0
  return Math.min(999, Math.round((totalWrittenWords.value / d.planned.targetWords) * 100))
})

// ── 字数曲线 SVG 尺度 ──
const CHART_W = 720
const CHART_H = 170
const PAD_BOTTOM = 22 // 章号标签
const PAD_LEFT = 34 // Y 轴刻度标签
const DRAW_W = CHART_W - PAD_LEFT
const maxWords = computed(() =>
  Math.max(1, ...(data.value?.wordCurve ?? []).map((p) => p.字数)),
)
// Y 轴网格刻度（maxWords 的 25/50/75% 处）
const Y_TICKS = [0.25, 0.5, 0.75]
/** 字数简写：≥1万→X.X万，≥1千→X.Xk，其余原值 */
function fmtWords(n: number): string {
  if (n >= 10000) return `${(n / 10000).toFixed(1)}万`
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`
  return String(Math.round(n))
}
function barX(i: number, n: number): number {
  const slot = DRAW_W / Math.max(1, n)
  return PAD_LEFT + i * slot + slot * 0.2
}
function barW(n: number): number {
  return (DRAW_W / Math.max(1, n)) * 0.6
}
function barY(字数: number): number {
  const h = (字数 / maxWords.value) * (CHART_H - PAD_BOTTOM - 10)
  return CHART_H - PAD_BOTTOM - h
}
function barH(字数: number): number {
  return (字数 / maxWords.value) * (CHART_H - PAD_BOTTOM - 10)
}
const avgY = computed(() => {
  const d = data.value
  if (!d) return 0
  return barY(d.avgWords)
})

// ── 分布对比组 ──
interface DistGroup { title: string; keys: string[]; written: RhythmDist; planned: RhythmDist }
const distGroups = computed<DistGroup[]>(() => {
  const d = data.value
  if (!d) return []
  return [
    { title: '钩子类型', keys: HOOK_TYPES, written: d.written.hookTypeDist, planned: d.planned.hookTypeDist },
    { title: '钩子强弱', keys: HOOK_LEVELS, written: d.written.hookLevelDist, planned: d.planned.hookLevelDist },
    { title: '情绪定位', keys: EMOTIONS, written: d.written.emotionDist, planned: d.planned.emotionDist },
    { title: '场景分布', keys: SCENE_TYPES, written: d.written.sceneDist, planned: d.planned.sceneDist },
  ]
})
function distMax(g: DistGroup): number {
  return Math.max(1, ...g.keys.map((k) => Math.max(g.written[k] ?? 0, g.planned[k] ?? 0)))
}

// ── AI 分析趋势（全书聚合 overview）──
const ui = useUiStore()
const overview = ref<AnalysisOverview | null>(null)
const aiOff = computed(() => ui.aiAvailable === false)

async function loadOverview(): Promise<void> {
  try {
    overview.value = await getAnalysisOverview(props.bookName)
  } catch {
    overview.value = null
  }
}

const allChapNums = computed(() => (overview.value?.allChapters ?? []).map((c) => c.章号))
const totalChapters = computed(() => allChapNums.value.length)
const scoreMap = computed(() => {
  const m = new Map<number, number>()
  for (const p of overview.value?.scoreTrend ?? []) m.set(p.章号, p.score)
  return m
})
const emotionMap = computed(() => {
  const m = new Map<number, { emotion: number; label: string }>()
  for (const p of overview.value?.emotionTrend ?? []) m.set(p.章号, { emotion: p.emotion, label: p.label })
  return m
})
const hooksMap = computed(() => {
  const m = new Map<number, { density: string; hookCount: number }>()
  for (const p of overview.value?.hooksTrend ?? []) m.set(p.章号, { density: p.density, hookCount: p.hookCount })
  return m
})
const analyzedCount = computed(() => scoreMap.value.size)
const missingChapters = computed(() =>
  (overview.value?.allChapters ?? []).filter((c) => !scoreMap.value.has(c.章号)),
)

// 逐章分析（跑 score/emotion/hooks 三 kind）+ 批量 + 文风
const analyzing = ref(false)
const batchProgress = ref({ done: 0, total: 0 })
const styleAnalyzing = ref(false)
const ANALYSIS_KINDS = ['score', 'emotion', 'hooks'] as const

async function analyzeChapter(docId: string): Promise<void> {
  if (analyzing.value) return
  analyzing.value = true
  try {
    for (const kind of ANALYSIS_KINDS) await runAnalyze(props.bookName, docId, kind)
    await loadOverview()
    ui.toast('分析完成', 'success')
  } catch (e) {
    ui.toast(e instanceof Error ? e.message : String(e), 'error')
  } finally {
    analyzing.value = false
  }
}
async function analyzeAll(): Promise<void> {
  const missing = missingChapters.value
  if (!missing.length || analyzing.value) return
  analyzing.value = true
  batchProgress.value = { done: 0, total: missing.length }
  try {
    for (const ch of missing) {
      for (const kind of ANALYSIS_KINDS) await runAnalyze(props.bookName, ch.docId, kind)
      batchProgress.value.done++
    }
    await loadOverview()
    ui.toast(`批量分析完成（${missing.length} 章）`, 'success')
  } catch (e) {
    ui.toast(e instanceof Error ? e.message : String(e), 'error')
  } finally {
    analyzing.value = false
  }
}
async function runStyle(): Promise<void> {
  if (styleAnalyzing.value) return
  styleAnalyzing.value = true
  try {
    await runStyleAnalysis(props.bookName)
    await loadOverview()
    ui.toast('文风分析完成', 'success')
  } catch (e) {
    ui.toast(e instanceof Error ? e.message : String(e), 'error')
  } finally {
    styleAnalyzing.value = false
  }
}

// ── AI 趋势 SVG 坐标 ──
const TREND_W = 720
const TREND_H = 120
const T_PAD_L = 30
const T_PAD_R = 10
const T_PAD_T = 10
const T_PAD_B = 22
const TREND_DW = TREND_W - T_PAD_L - T_PAD_R
const TREND_DH = TREND_H - T_PAD_T - T_PAD_B

function trendX(i: number, n: number): number {
  if (n <= 1) return T_PAD_L + TREND_DW / 2
  return T_PAD_L + (i / (n - 1)) * TREND_DW
}
function scoreY(v: number): number {
  return T_PAD_T + (1 - Math.max(0, Math.min(10, v)) / 10) * TREND_DH
}
function emotionY(v: number): number {
  const c = Math.max(-2, Math.min(2, v))
  return T_PAD_T + (1 - (c + 2) / 4) * TREND_DH
}

// 折线分段（缺数据处断开，不连线）
interface TrendSeg { x: number; y: number; 章号: number; val: number }
function buildSegments(
  nums: number[],
  valOf: (n: number) => number | undefined,
  yOf: (v: number) => number,
): TrendSeg[][] {
  const segs: TrendSeg[][] = []
  let cur: TrendSeg[] = []
  for (let i = 0; i < nums.length; i++) {
    const v = valOf(nums[i]!)
    if (v != null) {
      cur.push({ x: trendX(i, nums.length), y: yOf(v), 章号: nums[i]!, val: v })
    } else if (cur.length) {
      segs.push(cur)
      cur = []
    }
  }
  if (cur.length) segs.push(cur)
  return segs
}
const scoreSegs = computed(() =>
  buildSegments(allChapNums.value, (n) => scoreMap.value.get(n), scoreY),
)
const emotionSegs = computed(() =>
  buildSegments(allChapNums.value, (n) => emotionMap.value.get(n)?.emotion, emotionY),
)
function segPoints(seg: TrendSeg[]): string {
  return seg.map((p) => `${p.x},${p.y}`).join(' ')
}
</script>

<template>
  <div class="rhythm-scroll">
    <div v-if="loading" class="placeholder">载入节奏…</div>
    <div v-else-if="err" class="err-block">
      节奏载入失败：{{ err }}
      <button class="btn" @click="load">重试</button>
    </div>

    <!-- 短篇占位 -->
    <div v-else-if="isShort" class="placeholder">
      短篇集以单篇情绪为目标，无章纲节奏对比。
    </div>

    <div v-else-if="data" class="rhythm">
      <!-- 区1：字数曲线 -->
      <section class="card">
        <div class="card-head">
          字数曲线 · 已写 {{ data.wordCurve.length }} 章 · 均篇 {{ data.avgWords.toLocaleString() }} 字
        </div>
        <div v-if="!data.wordCurve.length" class="empty">尚无已写章节</div>
        <svg
          v-else
          class="chart"
          :viewBox="`0 0 ${CHART_W} ${CHART_H}`"
          preserveAspectRatio="xMidYMid meet"
        >
          <!-- Y 轴网格线 + 刻度标签 -->
          <text :x="2" :y="12" class="axis-label">字数</text>
          <g v-for="(t, idx) in Y_TICKS" :key="idx">
            <line :x1="PAD_LEFT" :x2="CHART_W" :y1="barY(maxWords * t)" :y2="barY(maxWords * t)" class="grid-line" />
            <text :x="PAD_LEFT - 4" :y="barY(maxWords * t) + 3" class="grid-label" text-anchor="end">{{ fmtWords(maxWords * t) }}</text>
          </g>
          <!-- 均篇虚线 -->
          <line :x1="PAD_LEFT" :x2="CHART_W" :y1="avgY" :y2="avgY" class="avg-line" />
          <text :x="CHART_W - 4" :y="avgY - 4" class="avg-text" text-anchor="end">均篇</text>
          <!-- 每章一条 -->
          <g v-for="(p, i) in data.wordCurve" :key="p.章号">
            <rect
              :x="barX(i, data.wordCurve.length)"
              :y="barY(p.字数)"
              :width="barW(data.wordCurve.length)"
              :height="barH(p.字数)"
              rx="1.5"
              class="bar-written"
            >
              <title>第{{ p.章号 }}章 {{ p.标题 }} · {{ p.字数.toLocaleString() }} 字</title>
            </rect>
            <text
              v-if="data.wordCurve.length <= 40"
              :x="barX(i, data.wordCurve.length) + barW(data.wordCurve.length) / 2"
              :y="CHART_H - 6"
              class="bar-label"
              text-anchor="middle"
            >{{ p.章号 }}</text>
          </g>
        </svg>
      </section>

      <!-- 区2：节奏分布对比 -->
      <section class="card">
        <div class="card-head">节奏分布对比<span class="legend">实色 已写 / 浅色 规划</span></div>
        <div class="dist-grid">
          <div v-for="g in distGroups" :key="g.title" class="dist-group">
            <div class="dist-title">{{ g.title }}</div>
            <div v-for="k in g.keys" :key="k" class="dist-row">
              <span class="dist-key">{{ k }}</span>
              <div class="dist-bars">
                <div class="bar-track">
                  <div
                    class="bar written"
                    :style="{ width: ((g.written[k] ?? 0) / distMax(g) * 100) + '%' }"
                  ></div>
                </div>
                <div class="bar-track">
                  <div
                    class="bar planned"
                    :style="{ width: ((g.planned[k] ?? 0) / distMax(g) * 100) + '%' }"
                  ></div>
                </div>
              </div>
              <span class="dist-val">{{ g.written[k] ?? 0 }}<span class="sep">/</span>{{ g.planned[k] ?? 0 }}</span>
            </div>
          </div>
        </div>
      </section>

      <!-- 区3：章纲覆盖 -->
      <section class="card">
        <div class="card-head">章纲覆盖</div>
        <div class="cov-row">
          <div class="cov"><label>规划</label><span class="cov-num">{{ data.planned.count }}</span></div>
          <div class="cov"><label>已写</label><span class="cov-num">{{ data.written.count }}</span></div>
          <div class="cov"><label>待写</label><span class="cov-num warn">{{ pendingChapters }}</span></div>
        </div>
        <div v-if="data.planned.targetWords" class="cov-words">
          <span>字数 {{ totalWrittenWords.toLocaleString() }} / {{ data.planned.targetWords.toLocaleString() }}</span>
          <div class="ach-track">
            <div class="ach-fill" :style="{ width: Math.min(100, wordAchievement) + '%' }"></div>
          </div>
          <span class="ach-pct">{{ wordAchievement }}%</span>
        </div>
      </section>

      <!-- 区4：逐章偏差（D3：章纲↔定稿 join，跑偏标红） -->
      <section class="card">
        <div class="card-head">逐章偏差<span class="legend">规→实 · 红字为跑偏</span></div>
        <div v-if="!data.chapterDiff.length" class="empty">无章纲或定稿数据</div>
        <div v-else class="diff-wrap">
          <table class="diff-table">
            <thead>
              <tr>
                <th class="num">章</th>
                <th>标题</th>
                <th>状态</th>
                <th>钩子</th>
                <th>情绪</th>
                <th>场景</th>
                <th class="num">字数 目/实</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="r in data.chapterDiff" :key="r.章号">
                <td class="num">{{ r.章号 }}</td>
                <td class="title">{{ r.标题 }}</td>
                <td>
                  <span
                    class="tag"
                    :class="{ 'tag-pending': r.状态 === '待写', 'tag-impromptu': r.状态 === '即兴' }"
                  >{{ r.状态 }}</span>
                </td>
                <td :class="{ diff: r.钩子类型偏差 }">{{ r.钩子类型 ?? '—' }}</td>
                <td :class="{ diff: r.情绪定位偏差 }">{{ r.情绪定位 ?? '—' }}</td>
                <td :class="{ diff: r.场景偏差 }">{{ r.场景 ?? '—' }}</td>
                <td class="num">{{ r.字数 ?? '—' }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <!-- 区5-8：AI 分析趋势 -->
      <section class="card ai-section">
        <div class="card-head">
          AI 分析趋势
          <span class="legend">{{ analyzedCount }}/{{ totalChapters }} 章已分析</span>
        </div>
        <div v-if="!totalChapters" class="empty">无正文章节</div>
        <template v-else>
          <!-- 批量分析 -->
          <div v-if="missingChapters.length" class="ai-batch">
            <button class="btn-batch" :disabled="aiOff || analyzing" @click="analyzeAll">
              <RefreshCw :size="12" :class="{ spin: analyzing }" />
              <span>{{ analyzing ? `分析中 ${batchProgress.done}/${batchProgress.total}` : `分析全部（${missingChapters.length} 章缺数据）` }}</span>
            </button>
          </div>

          <!-- 区5：体验分趋势 -->
          <div class="ai-subhead"><Sparkles :size="13" /><span>体验分</span></div>
          <svg :viewBox="`0 0 ${TREND_W} ${TREND_H}`" class="trend-chart" preserveAspectRatio="xMidYMid meet">
            <g v-for="t in [0, 5, 10]" :key="'sg'+t">
              <line :x1="T_PAD_L" :x2="TREND_W - T_PAD_R" :y1="scoreY(t)" :y2="scoreY(t)" class="grid-line" />
              <text :x="T_PAD_L - 4" :y="scoreY(t) + 3" class="grid-label" text-anchor="end">{{ t }}</text>
            </g>
            <polyline v-for="(seg, si) in scoreSegs" :key="'sp'+si" :points="segPoints(seg)" class="trend-line score-line" />
            <g v-for="(seg, si) in scoreSegs" :key="'sd'+si">
              <circle v-for="p in seg" :key="p.章号" :cx="p.x" :cy="p.y" r="3" class="trend-dot score-dot">
                <title>第{{ p.章号 }}章 · 体验分 {{ p.val }}</title>
              </circle>
            </g>
            <template v-if="allChapNums.length <= 40">
              <text v-for="(n, i) in allChapNums" :key="'sl'+n" :x="trendX(i, allChapNums.length)" :y="TREND_H - 6" class="bar-label" text-anchor="middle">{{ n }}</text>
            </template>
          </svg>

          <!-- 区6：情绪走势 -->
          <div class="ai-subhead"><Activity :size="13" /><span>情绪走势</span></div>
          <svg :viewBox="`0 0 ${TREND_W} ${TREND_H}`" class="trend-chart" preserveAspectRatio="xMidYMid meet">
            <g v-for="t in [-2, 0, 2]" :key="'eg'+t">
              <line :x1="T_PAD_L" :x2="TREND_W - T_PAD_R" :y1="emotionY(t)" :y2="emotionY(t)" :class="['grid-line', { 'zero-line': t === 0 }]" />
              <text :x="T_PAD_L - 4" :y="emotionY(t) + 3" class="grid-label" text-anchor="end">{{ t > 0 ? '+' + t : t }}</text>
            </g>
            <polyline v-for="(seg, si) in emotionSegs" :key="'ep'+si" :points="segPoints(seg)" class="trend-line emotion-line" />
            <g v-for="(seg, si) in emotionSegs" :key="'ed'+si">
              <circle v-for="p in seg" :key="p.章号" :cx="p.x" :cy="p.y" r="3" :class="['trend-dot', p.val >= 0 ? 'pos-dot' : 'neg-dot']">
                <title>第{{ p.章号 }}章 · {{ p.val }}</title>
              </circle>
            </g>
          </svg>

          <!-- 区7：钩子密度色块条 -->
          <div class="ai-subhead"><Anchor :size="13" /><span>钩子密度</span></div>
          <div class="hooks-strip">
            <div
              v-for="ch in overview?.allChapters ?? []"
              :key="'h'+ch.章号"
              class="hook-cell"
              :class="'density-' + (hooksMap.get(ch.章号)?.density ?? 'none')"
            >
              <span class="hook-num">{{ ch.章号 }}</span>
              <span class="hook-density">{{ hooksMap.get(ch.章号)?.density ?? '—' }}</span>
            </div>
          </div>

          <!-- 逐章分析（缺信封章节） -->
          <div v-if="missingChapters.length" class="missing-row">
            <span class="missing-label">缺数据：</span>
            <button
              v-for="ch in missingChapters"
              :key="'m'+ch.docId"
              class="btn-plus"
              :disabled="aiOff || analyzing"
              @click="analyzeChapter(ch.docId)"
            >+{{ ch.章号 }}</button>
          </div>

          <!-- 区8：文风总结 -->
          <div class="ai-subhead ai-subhead-style">
            <span class="ai-subhead-title"><Feather :size="13" /><span>文风总结</span></span>
            <button class="btn-style" :disabled="aiOff || styleAnalyzing" @click="runStyle">
              <RefreshCw :size="11" :class="{ spin: styleAnalyzing }" />
              <span>{{ styleAnalyzing ? '分析中…' : '重新分析' }}</span>
            </button>
          </div>
          <div v-if="overview?.style" class="style-body">
            <div class="style-drift">{{ overview.style.drift }}</div>
            <div v-if="overview.style.口癖?.length" class="style-tags">
              <span v-for="(t, i) in overview.style.口癖" :key="i" class="style-tag">{{ t }}</span>
            </div>
            <div v-if="overview.style.重复度评价" class="style-line">
              <span class="style-line-label">重复度</span>{{ overview.style.重复度评价 }}
            </div>
            <div v-if="overview.style.建议?.length" class="style-suggestions">
              <div v-for="(s, i) in overview.style.建议" :key="i" class="style-suggestion">{{ s }}</div>
            </div>
          </div>
          <div v-else class="empty">暂无文风分析{{ aiOff ? '' : '，点「重新分析」生成' }}</div>
        </template>
      </section>
    </div>
  </div>
</template>

<style scoped>
.rhythm-scroll {
  height: 100%;
  overflow: auto;
  padding: var(--size-4-4) var(--size-4-6);
}
.rhythm {
  display: flex;
  flex-direction: column;
  gap: var(--size-4-3);
  max-width: 760px;
  margin: 0 auto;
}
.card {
  background: var(--background-secondary);
  border: 1px solid var(--background-modifier-border);
  border-radius: var(--radius-m);
  padding: var(--size-4-3) var(--size-4-4);
  box-shadow: var(--shadow-s);
  animation: clw-card-in var(--dur-fast) var(--ease-out) both;
}
.card:nth-child(1) { animation-delay: 0ms; }
.card:nth-child(2) { animation-delay: 40ms; }
.card:nth-child(3) { animation-delay: 80ms; }
.card:nth-child(4) { animation-delay: 120ms; }
.card-head {
  font-size: var(--font-size-s);
  font-weight: 600;
  color: var(--text-muted);
  margin-bottom: var(--size-4-3);
  letter-spacing: 0.04em;
  display: flex;
  justify-content: space-between;
  align-items: baseline;
}
.legend {
  font-size: var(--font-size-xs);
  font-weight: 400;
  color: var(--text-faint);
}
.empty {
  font-size: var(--font-size-s);
  color: var(--text-faint);
  padding: var(--size-4-2) 0;
}

/* ── 字数曲线 SVG ── */
.chart {
  width: 100%;
  height: 170px;
}
.bar-written {
  fill: var(--interactive-accent);
  transform-box: fill-box;
  transform-origin: bottom;
  animation: clw-bar-grow var(--dur-slow) var(--ease-out);
}
.avg-line {
  stroke: var(--text-faint);
  stroke-width: 1;
  stroke-dasharray: 4 3;
  opacity: 0.6;
}
.avg-text {
  fill: var(--text-faint);
  font-size: var(--font-size-xxs);
}
.bar-label {
  fill: var(--text-faint);
  font-size: 9px;
}
.axis-label {
  fill: var(--text-faint);
  font-size: var(--font-size-xxs);
  font-weight: 500;
}
.grid-line {
  stroke: var(--background-modifier-border);
  stroke-width: 1;
  stroke-dasharray: 2 4;
  opacity: 0.5;
}
.grid-label {
  fill: var(--text-faint);
  font-size: var(--font-size-xxs);
  font-variant-numeric: tabular-nums;
}

/* ── 分布对比 ── */
.dist-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
  gap: var(--size-4-3) var(--size-4-4);
}
.dist-group {
  display: flex;
  flex-direction: column;
  gap: 5px;
}
.dist-title {
  font-size: var(--font-size-xs);
  font-weight: 600;
  color: var(--text-normal);
  margin-bottom: 2px;
}
.dist-row {
  display: grid;
  grid-template-columns: 64px 1fr 44px;
  align-items: center;
  gap: var(--size-4-2);
}
.dist-key {
  font-size: var(--font-size-xs);
  color: var(--text-muted);
}
.dist-bars {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.bar-track {
  height: 7px;
  background: var(--background-modifier-border);
  border-radius: 2px;
  overflow: hidden;
}
.bar {
  height: 100%;
  border-radius: 2px;
  transition: width var(--dur-slow) var(--ease-out);
}
.bar.written {
  background: var(--interactive-accent);
}
.bar.planned {
  background: var(--interactive-accent);
  opacity: 0.3;
}
.dist-val {
  font-size: var(--font-size-xs);
  color: var(--text-faint);
  text-align: right;
  font-variant-numeric: tabular-nums;
}
.dist-val .sep {
  margin: 0 2px;
  opacity: 0.5;
}

/* ── 章纲覆盖 ── */
.cov-row {
  display: flex;
  gap: var(--size-4-6);
  margin-bottom: var(--size-4-3);
}
.cov {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.cov label {
  font-size: var(--font-size-xs);
  color: var(--text-faint);
}
.cov-num {
  font-size: var(--font-size-2xl);
  font-weight: 600;
  color: var(--text-accent);
  line-height: 1;
  font-variant-numeric: tabular-nums;
}
.cov-num.warn {
  color: var(--text-warning);
}
.cov-words {
  display: flex;
  align-items: center;
  gap: var(--size-4-2);
  font-size: var(--font-size-s);
  color: var(--text-muted);
}
.ach-track {
  flex: 1;
  height: 6px;
  background: var(--background-modifier-border);
  border-radius: var(--radius-s);
  overflow: hidden;
}
.ach-fill {
  height: 100%;
  background: var(--interactive-accent);
  border-radius: var(--radius-s);
  transition: width var(--dur-slow) var(--ease-out);
}
.ach-pct {
  font-size: var(--font-size-s);
  font-weight: 600;
  color: var(--text-normal);
  font-variant-numeric: tabular-nums;
}

/* ── 逐章偏差表 ── */
.diff-wrap {
  max-height: 360px;
  overflow: auto;
  border: 1px solid var(--background-modifier-border);
  border-radius: var(--radius-s);
}
.diff-table {
  width: 100%;
  border-collapse: collapse;
  font-size: var(--font-size-xs);
}
.diff-table th {
  position: sticky;
  top: 0;
  background: var(--background-secondary);
  color: var(--text-faint);
  font-weight: 500;
  text-align: left;
  padding: 5px 8px;
  border-bottom: 1px solid var(--background-modifier-border);
  white-space: nowrap;
}
.diff-table td {
  padding: 4px 8px;
  border-bottom: 1px solid var(--background-modifier-border);
  color: var(--text-normal);
  white-space: nowrap;
}
.diff-table tr:last-child td {
  border-bottom: none;
}
.diff-table .num {
  font-variant-numeric: tabular-nums;
  text-align: right;
}
.diff-table .title {
  color: var(--text-muted);
  max-width: 160px;
  overflow: hidden;
  text-overflow: ellipsis;
}
.diff-table .diff {
  color: var(--text-error);
  font-weight: 600;
}
.tag {
  display: inline-block;
  padding: 1px 6px;
  border-radius: var(--radius-s);
  font-size: var(--font-size-xxs);
  border: 1px solid var(--background-modifier-border);
  color: var(--text-muted);
}
.tag-pending {
  color: var(--text-faint);
}
.tag-impromptu {
  color: var(--text-warning);
  border-color: var(--text-warning);
}

.placeholder {
  padding: var(--size-4-6);
  text-align: center;
  color: var(--text-faint);
  font-size: var(--font-size-m);
}
.err-block {
  padding: var(--size-4-4);
  text-align: center;
  color: var(--text-error);
  font-size: var(--font-size-m);
}
.btn {
  margin-left: var(--size-4-2);
  padding: 4px 12px;
  font-size: var(--font-size-s);
  border: 1px solid var(--background-modifier-border);
  border-radius: var(--radius-s);
  background: var(--background-primary);
  color: var(--text-normal);
  cursor: pointer;
}

/* ── AI 分析趋势 ── */
.ai-section {
  display: flex;
  flex-direction: column;
  gap: var(--size-4-2);
}
.ai-batch {
  display: flex;
}
.btn-batch {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 4px 10px;
  border: 1px solid var(--background-modifier-border);
  border-radius: var(--radius-s);
  background: var(--interactive-accent);
  color: var(--text-on-accent);
  font-size: var(--font-size-xs);
  cursor: pointer;
}
.btn-batch:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
.spin {
  animation: rv-spin 0.9s linear infinite;
}
@keyframes rv-spin {
  to {
    transform: rotate(360deg);
  }
}
.ai-subhead {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: var(--font-size-xs);
  font-weight: 600;
  color: var(--text-normal);
  margin-top: var(--size-4-1);
}
.ai-subhead-style {
  justify-content: space-between;
  width: 100%;
}
.ai-subhead-title {
  display: inline-flex;
  align-items: center;
  gap: 5px;
}
.btn-style {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 3px 8px;
  border: 1px solid var(--background-modifier-border);
  border-radius: var(--radius-s);
  background: var(--interactive-accent);
  color: var(--text-on-accent);
  font-size: var(--font-size-xxs);
  cursor: pointer;
}
.btn-style:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
.trend-chart {
  width: 100%;
  height: 120px;
}
.trend-line {
  fill: none;
  stroke-width: 1.5;
}
.score-line {
  stroke: var(--interactive-accent);
}
.emotion-line {
  stroke: var(--text-faint);
}
.zero-line {
  stroke: var(--text-muted);
  stroke-dasharray: 3 3;
}
.trend-dot {
  stroke: var(--background-secondary);
  stroke-width: 1;
}
.score-dot {
  fill: var(--interactive-accent);
}
.pos-dot {
  fill: var(--div-pos);
}
.neg-dot {
  fill: var(--div-neg);
}
/* 钩子密度色块条 */
.hooks-strip {
  display: flex;
  flex-wrap: wrap;
  gap: 3px;
}
.hook-cell {
  display: flex;
  flex-direction: column;
  align-items: center;
  min-width: 36px;
  padding: 3px 4px;
  border-radius: var(--radius-s);
  font-size: var(--font-size-xxs);
  border: 1px solid var(--background-modifier-border);
}
.hook-num {
  font-weight: 600;
  color: var(--text-normal);
}
.hook-density {
  color: var(--text-faint);
}
.density-密 {
  background: color-mix(in srgb, var(--dv-bad) 12%, transparent);
  border-color: color-mix(in srgb, var(--dv-bad) 25%, transparent);
}
.density-中 {
  background: color-mix(in srgb, var(--dv-good) 12%, transparent);
  border-color: color-mix(in srgb, var(--dv-good) 25%, transparent);
}
.density-疏 {
  background: color-mix(in srgb, var(--dv-warn) 12%, transparent);
  border-color: color-mix(in srgb, var(--dv-warn) 25%, transparent);
}
.density-none {
  opacity: 0.5;
}
/* 缺数据逐章按钮 */
.missing-row {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 4px;
}
.missing-label {
  font-size: var(--font-size-xs);
  color: var(--text-faint);
}
.btn-plus {
  padding: 1px 6px;
  border: 1px solid var(--background-modifier-border);
  border-radius: var(--radius-s);
  background: var(--background-primary);
  color: var(--text-muted);
  font-size: var(--font-size-xxs);
  cursor: pointer;
}
.btn-plus:hover:not(:disabled) {
  background: var(--background-modifier-hover);
  color: var(--text-normal);
}
.btn-plus:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
/* 文风总结 */
.style-body {
  display: flex;
  flex-direction: column;
  gap: var(--size-4-2);
}
.style-drift {
  font-size: var(--font-size-m);
  color: var(--text-normal);
  line-height: 1.5;
}
.style-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}
.style-tag {
  font-size: var(--font-size-xs);
  padding: 1px 8px;
  border-radius: 8px;
  background: color-mix(in srgb, var(--dv-warn) 12%, transparent);
  color: var(--dv-warn);
}
.style-line {
  font-size: var(--font-size-s);
  color: var(--text-muted);
}
.style-line-label {
  color: var(--text-faint);
  margin-right: 4px;
}
.style-suggestions {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding-left: 8px;
  border-left: 2px solid var(--background-modifier-border);
}
.style-suggestion {
  font-size: var(--font-size-s);
  color: var(--text-normal);
  line-height: 1.5;
}
</style>
