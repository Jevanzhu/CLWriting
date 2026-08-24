<script setup lang="ts">
// 总览视图（v5 · Bento 仪表盘）：拓宽 940px + 不规则网格 + 大数字 KPI +
// 面积图 + 实线 hairline 网格。图表设计遵循 dataviz 规范。
// 结构：①Hero(KPI) → ②热力(6):伏笔(4) → ③字数曲线(面积) →
//       ④节奏分布(子弹图) → ⑤文风摘要卡（完整功能在文风工作台）
// 短篇不显示 ③④（无章纲数据）；文风摘要 ⑤ 长短篇通用（有正文即可）。
// hh §八-16 拆分：③ → overview/WordCurveChart，④ → overview/RhythmDistPanel，
// 短篇画像缺口 → overview/ShortProfileGaps（纯搬家，DOM 不变）。
import { ref, computed, onMounted } from 'vue'
import {
  Flame, AlertTriangle,
  Feather, ArrowUpRight,
  PenLine,
} from 'lucide-vue-next'
import { getOverview, type OverviewResult } from '../api/overview'
import { getForeshadows, type Foreshadow } from '../api/foreshadows'
import { getRhythm, type RhythmResult } from '../api/rhythm'
import {
  getAnalysisOverview,
  type AnalysisOverview,
} from '../api/analysis'
import { useWorkspaceStore } from '../stores/workspace'
import { useTreeStore } from '../stores/tree'
import { friendlyError } from '../shared/error'
import WordCurveChart from '../components/overview/WordCurveChart.vue'
import RhythmDistPanel from '../components/overview/RhythmDistPanel.vue'
import ShortProfileGaps from '../components/overview/ShortProfileGaps.vue'

const props = defineProps<{ bookName: string }>()
const ws = useWorkspaceStore()
const tree = useTreeStore()

/** 继续写作：跳到最近一章（path → docId → openTab）。 */
function continueWriting(): void {
  const rc = data.value?.recentDoc
  if (!rc) return
  const node = tree.byPath.get(rc.path)
  if (node?.docId) {
    ws.openTab(node.docId)
  } else {
    // 树未命中（树未加载/缓存旧）→ 重拉后再打开
    // B-10（第六十轮）：在途切书守卫——重拉在途切书后旧闭包不再按 A 书树开 tab
    const book = props.bookName
    void tree.load(book, true).then(() => {
      if (props.bookName !== book) return
      const n = tree.byPath.get(rc.path)
      if (n?.docId) ws.openTab(n.docId)
    })
  }
}

// ── 数据 refs ─────────────────────────────────
const data = ref<OverviewResult | null>(null)
const foreshadows = ref<Foreshadow[]>([])
const rhythmData = ref<RhythmResult | null>(null)
const analysis = ref<AnalysisOverview | null>(null)
const loading = ref(true)
const err = ref<string | null>(null)

// onMounted 并行加载 4 个 API（容错：单个失败不阻断页面）
async function loadAll(): Promise<void> {
  loading.value = true
  err.value = null
  try {
    data.value = await getOverview(props.bookName)
  } catch (e) {
    err.value = friendlyError(e)
  } finally {
    loading.value = false
  }
  void loadFs()
  void loadRhythm()
  void loadAnalysis()
}
async function loadFs(): Promise<void> {
  try { foreshadows.value = await getForeshadows(props.bookName) } catch { /* 静默 */ }
}
async function loadRhythm(): Promise<void> {
  try {
    const r = await getRhythm(props.bookName)
    rhythmData.value = r
  } catch { rhythmData.value = null }
}
async function loadAnalysis(): Promise<void> {
  try { analysis.value = await getAnalysisOverview(props.bookName) } catch { analysis.value = null }
}
function reload(): Promise<void> { return loadAll() }
onMounted(loadAll)

// ══ ①②③ 总览派生 ═════════════════════════════
const kind = computed<'long' | 'short'>(() => data.value?.identity.kind ?? 'long')
const title = computed(() => data.value?.identity.title || data.value?.identity.name || '—')
const genre = computed(() => data.value?.identity.genre || '')
const chapters = computed(() => data.value?.progress.chapters ?? 0)
const words = computed(() => data.value?.progress.words ?? 0)
const percent = computed(() => data.value?.progress.percent ?? 0)
const streak = computed(() => data.value?.streak ?? 0)
const wordsFmt = computed(() =>
  words.value >= 10000 ? (words.value / 10000).toFixed(1) + '万' : words.value.toLocaleString(),
)
const targetFmt = computed(() => {
  const t = data.value?.progress.targetWords
  return t ? (t >= 10000 ? (t / 10000).toFixed(0) + '万' : t.toLocaleString()) : null
})
const hasTarget = computed(() => !!targetFmt.value)
// F-P1-6：Date.now() 非响应式——创作天数只在 data 变化时重算（跨日差 1 天，不影响体验）
const days = computed(() => {
  const c = data.value?.identity.created_at
  if (!c) return 0
  return Math.max(1, Math.floor((Date.now() - new Date(c).getTime()) / 86400000))
})
/** 有产出的天数（timeline 只记有章节定稿的日子）。 */
const activeDays = computed(() => (data.value?.timeline ?? []).filter((t) => t.count > 0).length)
/** 写作日均：总字数 ÷ 有产出天数。用自然日当分母会把「建书 100 天只写了 3 天」
 *  摊成一个没意义的小数，作者想看的是「动笔那几天，一天写多少」。 */
const avgWords = computed(() => (activeDays.value > 0 ? Math.round(words.value / activeDays.value) : 0))
const avgWordsFmt = computed(() =>
  avgWords.value >= 10000
    ? (avgWords.value / 10000).toFixed(1) + '万'
    : avgWords.value.toLocaleString(),
)
const maxCount = computed(() => Math.max(1, ...(data.value?.timeline ?? []).map((t) => t.count)))

// ── 写作热力：逐日补齐 ──
// timeline 只含有产出的日子，直接 v-for 会让 7/24 和 7/28 视觉相邻——断更看不出来。
// 故按日历补零填满；窗口取最近 90 天（新书从建书日起），避免老书排出几百格。
const HEAT_DAYS = 90
const DAY_MS = 86400000
function ymd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
const heatCells = computed<{ date: string; count: number }[]>(() => {
  const tl = data.value?.timeline ?? []
  if (!tl.length) return []
  const byDate = new Map(tl.map((t) => [t.date, t.count]))
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const earliest = new Date(`${tl.reduce((a, t) => (t.date < a ? t.date : a), tl[0]!.date)}T00:00:00`)
  const windowStart = new Date(today.getTime() - (HEAT_DAYS - 1) * DAY_MS)
  const start = earliest > windowStart ? earliest : windowStart
  const cells: { date: string; count: number }[] = []
  // 用 setDate 按日历日推进：+86400000 在有夏令时的时区会漂出重复/缺失的一天
  for (const d = new Date(start); d <= today; d.setDate(d.getDate() + 1)) {
    const key = ymd(d)
    cells.push({ date: key, count: byDate.get(key) ?? 0 })
  }
  return cells
})

// 进度环
const RING_R = 44
const C = 2 * Math.PI * RING_R
const ringOffset = computed(() => C * (1 - percent.value / 100))
/** 百分比显示：0~1 区间收敛成 "<1"，避免 24px 大字位上出现 "0.2"。 */
const percentFmt = computed(() => {
  const p = percent.value
  if (p > 0 && p < 1) return '<1'
  return String(Math.round(p))
})

// 伏笔健康度
const fsStats = computed(() => {
  const pending = foreshadows.value.filter((f) => f.状态 === '未回收')
  return {
    红: pending.filter((f) => f.足迹?.risk === '红').length,
    黄: pending.filter((f) => f.足迹?.risk === '黄').length,
    绿: pending.filter((f) => f.足迹?.risk === '绿').length,
    已回收: foreshadows.value.filter((f) => f.状态 === '已回收').length,
    total: foreshadows.value.length,
  }
})

</script>

<template>
  <div class="ov-scroll">
    <div v-if="loading" class="ov-placeholder">载入总览…</div>
    <div v-else-if="err" class="ov-err">
      总览载入失败：{{ err }}
      <button class="btn-retry" @click="reload">重试</button>
    </div>

    <div v-else-if="data" class="overview">
      <!-- ── ① Hero · Bento（渐变底 + KPI tiles + 继续写作）── -->
      <section class="hero">
        <div class="hero-top">
          <div class="hero-left">
            <div class="hero-tags">
              <span class="htag solid">{{ kind === 'long' ? '长篇' : '短篇集' }}</span>
              <span v-if="genre" class="htag">{{ genre }}</span>
              <span v-if="streak > 0" class="htag streak">
                <Flame :size="11" /> {{ streak }} 天连续
              </span>
            </div>
            <h1 class="hero-title">{{ title }}</h1>
          </div>
          <div class="hero-right">
            <button v-if="data?.recentDoc" class="btn-continue" @click="continueWriting">
              <PenLine :size="13" />
              <span>继续写作 · 第{{ data.recentDoc.no }}章</span>
            </button>
            <div v-if="hasTarget" class="hero-ring">
              <svg viewBox="0 0 110 110" class="ring-svg" role="img" aria-label="字数完成进度">
                <circle cx="55" cy="55" :r="RING_R" class="ring-track" />
                <circle cx="55" cy="55" :r="RING_R" class="ring-prog"
                  :stroke-dasharray="C" :stroke-dashoffset="ringOffset" />
              </svg>
              <div class="ring-label">
                <span class="rl-num">{{ percentFmt }}</span>
                <span class="rl-pct">%</span>
              </div>
            </div>
          </div>
        </div>
        <!-- KPI stat tiles -->
        <div class="hero-kpis">
          <div class="kpi kpi-hero">
            <span class="kpi-val">{{ wordsFmt }}</span>
            <span class="kpi-label">总字数</span>
          </div>
          <div class="kpi">
            <span class="kpi-val">{{ chapters }}<small class="kpi-unit">章</small></span>
            <span class="kpi-label">章节</span>
          </div>
          <div class="kpi">
            <span class="kpi-val">{{ avgWordsFmt }}</span>
            <span class="kpi-label">写作日均</span>
          </div>
          <div v-if="streak > 0" class="kpi">
            <span class="kpi-val">{{ streak }}<small class="kpi-unit">天</small></span>
            <span class="kpi-label">连续</span>
          </div>
          <div v-else-if="days > 0" class="kpi">
            <span class="kpi-val">{{ days }}<small class="kpi-unit">天</small></span>
            <span class="kpi-label">创作</span>
          </div>
        </div>
        <!-- 底部：进度条（标出分母，否则只有一个孤零零的百分比）-->
        <div v-if="hasTarget" class="hero-foot">
          <div class="hbar-track">
            <div class="hbar-fill" :style="{ width: Math.max(1.5, percent) + '%' }"></div>
          </div>
          <div class="hbar-meta">
            <span>已写 {{ wordsFmt }}</span>
            <span>目标 {{ targetFmt }}</span>
          </div>
        </div>
      </section>

      <!-- ── ② 双列：写作热力(6) + 伏笔健康度(4) ── -->
      <div class="bento-2" :class="{ 'bento-single': fsStats.total === 0 }">
        <!-- 写作热力 -->
        <section class="panel">
          <div class="panel-head">
            <Flame :size="14" /> <span>写作热力</span>
            <span v-if="heatCells.length" class="head-legend">
              近 {{ heatCells.length }} 天 · {{ activeDays }} 天有写作
            </span>
          </div>
          <div v-if="heatCells.length" class="heat-grid">
            <span
              v-for="t in heatCells"
              :key="t.date"
              class="heat-cell"
              :class="{ 'is-empty': t.count === 0 }"
              :style="t.count ? { opacity: 0.25 + 0.75 * (t.count / maxCount) } : undefined"
              :title="t.count ? `${t.date} · ${t.count} 章` : `${t.date} · 未定稿`"
            ></span>
          </div>
          <div v-else class="heat-empty">
            <Flame :size="24" />
            <span>写一章定稿后亮起</span>
          </div>
        </section>

        <!-- 伏笔健康度 -->
        <section v-if="fsStats.total > 0" class="panel">
          <div class="panel-head">
            <AlertTriangle :size="14" /> <span>伏笔健康度</span>
          </div>
          <div class="fs-rows">
            <div class="fs-row r-红">
              <span class="fs-dot"></span>
              <span class="fs-n">{{ fsStats.红 }}</span>
              <span class="fs-t">高风险</span>
            </div>
            <div class="fs-row r-黄">
              <span class="fs-dot"></span>
              <span class="fs-n">{{ fsStats.黄 }}</span>
              <span class="fs-t">预警</span>
            </div>
            <div class="fs-row r-绿">
              <span class="fs-dot"></span>
              <span class="fs-n">{{ fsStats.绿 }}</span>
              <span class="fs-t">健康</span>
            </div>
          </div>
          <div v-if="fsStats.已回收" class="fs-foot">已回收 {{ fsStats.已回收 }} 个</div>
        </section>
      </div>

      <!-- ── ③ 字数曲线（面积图）── -->
      <WordCurveChart :rhythm-data="rhythmData" />

      <!-- ── 短篇画像缺口（短篇专属）── -->
      <ShortProfileGaps :short-profile="data?.shortProfile" :rhythm-data="rhythmData" />

      <!-- ── ④ 节奏分布（emphasis：已写=accent，规划=灰）── -->
      <RhythmDistPanel :rhythm-data="rhythmData" />

      <!-- ── ⑤ 文风摘要（存量一句话+口癖；完整验收/收割在文风工作台）── -->
      <section v-if="chapters > 0" class="panel">
        <div class="panel-head">
          <Feather :size="14" /> <span>文风摘要</span>
          <button class="btn-style" @click="ws.setActiveView('style')">
            <span>文风工作台</span>
            <ArrowUpRight :size="11" />
          </button>
        </div>
        <div v-if="analysis?.style" class="style-body">
          <div class="style-drift">{{ analysis.style.drift }}</div>
          <div v-if="analysis.style.口癖?.length" class="style-tags">
            <span v-for="(t, i) in analysis.style.口癖" :key="i" class="style-tag">{{ t }}</span>
          </div>
        </div>
        <div v-else class="empty">暂无文风分析，到文风工作台开始分析</div>
      </section>
    </div>
  </div>
</template>

<style scoped>
.ov-scroll { height: 100%; overflow: auto; padding: var(--size-4-5) var(--size-4-6); }
.overview { display: flex; flex-direction: column; gap: var(--size-4-4); max-width: 940px; margin: 0 auto; }

/* ══ 面板基础 ══ */
.panel {
  background: var(--background-primary);
  border: 1px solid var(--background-modifier-border);
  border-radius: var(--radius-l);
  padding: 18px 20px;
  animation: clw-fade-up var(--dur-fast) var(--ease-out) both;
}

.head-legend { margin-left: auto; font-weight: 400; font-size: var(--font-size-xs); color: var(--text-muted); }
.empty { font-size: var(--font-size-s); color: var(--text-faint); padding: var(--size-4-2) 0; }

/* stagger */
.hero { animation: clw-fade-up 0.5s var(--ease-out) both; }
.bento-2 .panel:nth-child(1) { animation-delay: 80ms; }
.bento-2 .panel:nth-child(2) { animation-delay: 120ms; }

/* ══ ① Hero ══ */
.hero {
  background:
    radial-gradient(ellipse 80% 100% at 100% 0%,
      color-mix(in srgb, var(--interactive-accent) 12%, transparent), transparent 65%),
    linear-gradient(135deg,
      color-mix(in srgb, var(--interactive-accent) 5%, var(--background-primary)),
      var(--background-primary));
  border: 1px solid var(--background-modifier-border);
  border-radius: var(--radius-l);
  padding: 26px 28px 18px;
  overflow: hidden;
}
.hero-top { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; }
.hero-left { display: flex; flex-direction: column; gap: 4px; }
.hero-right { display: flex; align-items: center; gap: 14px; flex-shrink: 0; }
.btn-continue {
  display: inline-flex; align-items: center; gap: 5px;
  padding: 7px 14px; border: 1px solid var(--interactive-accent);
  border-radius: var(--radius-m); background: color-mix(in srgb, var(--interactive-accent) 12%, transparent);
  color: var(--text-accent); font-size: var(--font-size-s); font-weight: 600; cursor: pointer;
  white-space: nowrap;
  transition: all var(--dur-fast) var(--ease-out);
}
.btn-continue:hover { background: color-mix(in srgb, var(--interactive-accent) 20%, transparent); border-color: var(--interactive-accent-hover); }
.hero-tags { display: flex; gap: 6px; margin-bottom: 8px; }
.htag {
  display: inline-flex; align-items: center; gap: 3px;
  font-size: var(--font-size-xs); font-weight: 500;
  padding: 2px 9px; border-radius: 99px;
  background: var(--background-modifier-hover); color: var(--text-muted);
}
.htag.solid { background: color-mix(in srgb, var(--interactive-accent) 14%, transparent); color: var(--text-accent); }
.htag.streak { background: color-mix(in srgb, var(--text-error) 12%, transparent); color: var(--text-error); }
.htag.streak svg { stroke-width: 2.5; }
.hero-title { margin: 0; font-size: 34px; font-weight: 700; line-height: 1.15; letter-spacing: -0.02em; color: var(--text-normal); }

/* 进度环 */
.hero-ring { position: relative; width: 88px; height: 88px; flex-shrink: 0; }
.ring-svg { width: 100%; height: 100%; transform: rotate(-90deg); }
.ring-track { fill: none; stroke: var(--background-modifier-border); stroke-width: 7; }
.ring-prog {
  fill: none; stroke: var(--interactive-accent); stroke-width: 7; stroke-linecap: round;
  transition: stroke-dashoffset 0.9s var(--ease-out);
  filter: drop-shadow(0 0 3px color-mix(in srgb, var(--interactive-accent) 30%, transparent));
}
.ring-label { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; gap: 1px; }
.rl-num { font-size: var(--font-size-2xl); font-weight: 700; color: var(--text-normal); }
.rl-pct { font-size: var(--font-size-m); color: var(--text-faint); }

/* KPI stat tiles */
.hero-kpis { display: flex; gap: 0; margin: 22px 0 18px; }
.kpi { flex: 1; position: relative; padding: 0 18px; }
.kpi:first-child { padding-left: 0; }
.kpi + .kpi::before {
  content: ''; position: absolute; left: 0; top: 50%; transform: translateY(-50%);
  width: 1px; height: 30px; background: var(--background-modifier-border);
}
.kpi-val { display: block; font-size: 30px; font-weight: 700; letter-spacing: -0.02em; color: var(--text-normal); line-height: 1.1; }
.kpi-hero .kpi-val { color: var(--text-accent); }
.kpi-unit { font-size: var(--font-size-m); font-weight: 500; color: var(--text-muted); margin-left: 3px; }
.kpi-label { display: block; font-size: var(--font-size-xs); color: var(--text-muted); margin-top: 5px; }

/* 底部 */
.hero-foot { display: flex; flex-direction: column; gap: 6px; }
.hbar-track { height: 3px; border-radius: 99px; background: var(--background-modifier-border); overflow: hidden; }
.hbar-fill { height: 100%; border-radius: 99px; background: var(--interactive-accent); transition: width 0.9s var(--ease-out); }
.hbar-meta { display: flex; justify-content: space-between; font-size: var(--font-size-xs); color: var(--text-muted); font-variant-numeric: tabular-nums; }

/* ══ ② Bento 双列 ══ */
.bento-2 { display: grid; grid-template-columns: 6fr 4fr; gap: var(--size-4-4); }
.bento-single { grid-template-columns: 1fr; }

/* 热力 */
.heat-grid { display: flex; flex-wrap: wrap; gap: 3px; }
.heat-cell { width: 12px; height: 12px; border-radius: 2px; background: var(--interactive-accent); transition: transform var(--dur-fast) var(--ease-out); }
/* 空白日：铺底色而非 accent 淡化，断更区间才看得出是「没写」而不是「写得少」 */
.heat-cell.is-empty { background: var(--background-modifier-border); opacity: 0.55; }
.heat-cell:hover { transform: scale(1.4); }
.heat-empty { display: flex; flex-direction: column; align-items: center; gap: 8px; padding: 16px 0; color: var(--text-faint); font-size: var(--font-size-xs); }
.heat-empty svg { opacity: 0.25; }

/* 伏笔 */
.fs-rows { display: flex; flex-direction: column; gap: 10px; }
.fs-row { display: flex; align-items: center; gap: 8px; }
.fs-dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
.fs-row.r-红 .fs-dot { background: var(--text-error); box-shadow: 0 0 5px color-mix(in srgb, var(--text-error) 50%, transparent); }
.fs-row.r-黄 .fs-dot { background: var(--text-warning); }
.fs-row.r-绿 .fs-dot { background: var(--dv-good); }
.fs-n { font-size: var(--font-size-2xl); font-weight: 700; font-variant-numeric: tabular-nums; min-width: 22px; color: var(--text-normal); }
.fs-t { font-size: var(--font-size-xs); color: var(--text-faint); }
.fs-foot { margin-top: 10px; font-size: var(--font-size-xs); color: var(--text-faint); }

/* ══ ⑤ 文风摘要 ══ */
.btn-style {
  display: inline-flex; align-items: center; gap: 4px;
  padding: 3px 8px; border: 1px solid var(--background-modifier-border);
  border-radius: var(--radius-s); background: var(--background-primary);
  color: var(--text-muted); font-size: var(--font-size-xxs); cursor: pointer; margin-left: auto;
}
.btn-style:hover { color: var(--text-normal); background: var(--background-modifier-hover); }
.style-body { display: flex; flex-direction: column; gap: var(--size-4-2); }
.style-drift { font-size: var(--font-size-m); color: var(--text-normal); line-height: 1.5; }
.style-tags { display: flex; flex-wrap: wrap; gap: 4px; }
.style-tag { font-size: var(--font-size-xs); padding: 1px 8px; border-radius: 8px; background: color-mix(in srgb, var(--dv-warn) 12%, transparent); color: var(--dv-warn); }

/* ══ 动画 ══ */

/* ══ 杂项 ══ */
.ov-placeholder { padding: 80px 0; text-align: center; color: var(--text-faint); font-size: var(--font-size-m); }
.ov-err { padding: 40px; text-align: center; color: var(--text-error); font-size: var(--font-size-m); }
.btn-retry { margin-left: 8px; padding: 4px 12px; font-size: var(--font-size-s); border: 1px solid var(--background-modifier-border); border-radius: var(--radius-s); background: var(--background-primary); color: var(--text-normal); cursor: pointer; }

/* 窄屏 */
@media (max-width: 600px) {
  .hero-ring { display: none; }
  .bento-2 { grid-template-columns: 1fr; }
  .hero-kpis { flex-wrap: wrap; }
  .kpi { flex: 1 1 40%; }
  .kpi + .kpi::before { display: none; }
}
</style>
