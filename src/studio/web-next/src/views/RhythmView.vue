<script setup lang="ts">
// 节奏视图（块4）：GET /rhythm 渲染 长篇双轨对比。
// 三区：字数曲线（已写波动）+ 节奏分布（written/planned 双条）+ 章纲覆盖（规划/已写/待写/达成率）。
// 短篇无章纲节奏 → 占位。纯 SVG 可视化，无图表库。
import { ref, computed, onMounted } from 'vue'
import { getRhythm, type RhythmLong, type RhythmDist } from '../api/rhythm'

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
onMounted(load)

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
const maxWords = computed(() =>
  Math.max(1, ...(data.value?.wordCurve ?? []).map((p) => p.字数)),
)
function barX(i: number, n: number): number {
  const slot = CHART_W / Math.max(1, n)
  return i * slot + slot * 0.2
}
function barW(n: number): number {
  return (CHART_W / Math.max(1, n)) * 0.6
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
          <!-- 均篇虚线 -->
          <line :x1="0" :x2="CHART_W" :y1="avgY" :y2="avgY" class="avg-line" />
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
</style>
