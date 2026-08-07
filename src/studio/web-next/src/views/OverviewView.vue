<script setup lang="ts">
// 总览视图（v5 · Bento 仪表盘）：拓宽 940px + 不规则网格 + 大数字 KPI +
// 面积图 + 实线 hairline 网格。图表设计遵循 dataviz 规范。
// 结构：①Hero(KPI) → ②热力(6):伏笔(4) → ③字数曲线(面积) →
//       ④节奏分布(子弹图) → ⑤文风摘要卡（完整功能在文风工作台）
// 短篇不显示 ③④（无章纲数据）；文风摘要 ⑤ 长短篇通用（有正文即可）。
import { ref, computed, onMounted } from 'vue'
import {
  Flame, AlertTriangle,
  Feather, ArrowUpRight,
  TrendingUp, BarChart3, PenLine, Info,
} from 'lucide-vue-next'
import { getOverview, type OverviewResult } from '../api/overview'
import { getForeshadows, type Foreshadow } from '../api/foreshadows'
import { getRhythm, type RhythmDist, type RhythmResult } from '../api/rhythm'
import {
  getAnalysisOverview,
  type AnalysisOverview,
} from '../api/analysis'
import { useWorkspaceStore } from '../stores/workspace'
import { useTreeStore } from '../stores/tree'
import { friendlyError } from '../shared/error'

const props = defineProps<{ bookName: string }>()
const ws = useWorkspaceStore()
const tree = useTreeStore()

/** 继续写作：跳到最近一章/篇（path → docId → openTab）。 */
function continueWriting(): void {
  const rc = data.value?.recentDoc
  if (!rc) return
  const node = tree.byPath.get(rc.path)
  if (node?.docId) {
    ws.openTab(node.docId)
  } else {
    // 树未命中（树未加载/缓存旧）→ 重拉后再打开
    void tree.load(props.bookName, true).then(() => {
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

// ══ 短篇画像缺口 ══
const shortProfile = computed(() => data.value?.shortProfile)
/** 情绪缺口：target_emotions vs 已写篇的目标情绪分布 */
const emotionGap = computed(() => {
  const profile = shortProfile.value
  if (!profile?.targetEmotions?.length) return null
  const dist = rhythmData.value?.kind === 'short' ? rhythmData.value.emotionDist : {}
  return profile.targetEmotions.map((e) => ({
    emotion: e,
    count: dist[e] ?? 0,
    missing: (dist[e] ?? 0) === 0,
  }))
})
/** 跨篇母题 */
const seriesMotifs = computed(() => shortProfile.value?.seriesMotifs ?? [])

/** 反转类型缺口：target_reversal_types vs 已写篇核心反转归类（派生自 rhythm） */
const reversalGap = computed(() => {
  const profile = shortProfile.value
  if (!profile?.targetReversalTypes?.length) return null
  const d = rhythmData.value
  if (d?.kind !== 'short') return null
  return d.reversalGap
})
/** 未归类篇数（规则未命中 / 池外类型） */
const reversalUnrecognized = computed(() => {
  const d = rhythmData.value
  return d?.kind === 'short' ? (d.reversalUnrecognized ?? 0) : 0
})


// ══ ④⑤ 节奏派生（原 RhythmView）══════════════
// 枚举顺序与服务端 rhythm.ts 一致（稳定渲染）
const HOOK_TYPES = ['危机钩', '悬念钩', '渴望钩', '情绪钩', '选择钩']
const EMOTIONS = ['压抑', '铺垫', '小爽', '大爽', '转折']
const SCENE_TYPES = ['战斗', '对话', '抒情', '叙事铺陈', '爽点高潮']

// ── 字数曲线 SVG 尺度（面积图）──
const CHART_W = 880
const CHART_H = 180
const PAD_BOTTOM = 24 // 章号标签
const PAD_LEFT = 38   // Y 轴刻度标签
const DRAW_W = CHART_W - PAD_LEFT
/** 字数曲线点（长短篇统一：长篇章号 / 短篇篇号 → no）。 */
const curve = computed<{ no: number; 标题: string; 字数: number }[]>(() => {
  const d = rhythmData.value
  if (!d) return []
  // 类型守卫（P2-20）：按 d.kind 收窄 wordCurve 元素形状（长篇章号 / 短篇篇号），替代 as 断言
  return d.kind === 'short'
    ? d.wordCurve.map((p) => ({ no: p.篇号, 标题: p.标题, 字数: p.字数 }))
    : d.wordCurve.map((p) => ({ no: p.章号, 标题: p.标题, 字数: p.字数 }))
})
const curveAvg = computed(() => {
  const c = curve.value
  return c.length ? Math.round(c.reduce((s, p) => s + p.字数, 0) / c.length) : 0
})
const maxWords = computed(() => Math.max(1, ...curve.value.map((p) => p.字数)))
const Y_TICKS = [0.25, 0.5, 0.75]
/** X 轴标签步长：控制在 ~20 个标签内。超 40 章就整排隐藏会让长篇横轴彻底失去参照。 */
const tickStep = computed(() => {
  const n = curve.value.length
  return Math.max(1, Math.ceil(n / 20))
})
/** 字数简写：≥1万→X.X万，≥1千→X.Xk，其余原值 */
function fmtWords(n: number): string {
  if (n >= 10000) return `${(n / 10000).toFixed(1)}万`
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`
  return String(Math.round(n))
}
/** 面积/折线图点 x（章节槽中心）*/
function ptX(i: number, n: number): number {
  const slot = DRAW_W / Math.max(1, n)
  return PAD_LEFT + i * slot + slot * 0.5
}
/** 点 y（字数→高度）*/
function barY(字数: number): number {
  const h = (字数 / maxWords.value) * (CHART_H - PAD_BOTTOM - 14)
  return CHART_H - PAD_BOTTOM - h
}
const avgY = computed(() => {
  const c = curve.value
  return c.length ? barY(curveAvg.value) : 0
})
/** 面积路径 d（底→各点→底→闭合）*/
const wordAreaD = computed(() => {
  const pts = curve.value
  if (!pts.length) return ''
  const n = pts.length
  const baseY = CHART_H - PAD_BOTTOM
  const ptsStr = pts.map((p, i) => `${ptX(i, n)},${barY(p.字数)}`).join(' L ')
  return `M ${ptX(0, n)},${baseY} L ${ptsStr} L ${ptX(n - 1, n)},${baseY} Z`
})
/** 折线路径 d */
const wordLineD = computed(() => {
  const pts = curve.value
  if (!pts.length) return ''
  const n = pts.length
  return pts.map((p, i) => `${i === 0 ? 'M' : 'L'} ${ptX(i, n)},${barY(p.字数)}`).join(' ')
})

// ── 分布对比组 ──
interface DistGroup { title: string; keys: string[]; written: RhythmDist; planned: RhythmDist }
const distGroups = computed<DistGroup[]>(() => {
  const d = rhythmData.value
  if (!d) return []
  if (d.kind === 'long') {
    return [
      { title: '钩子类型', keys: HOOK_TYPES, written: d.written.hookTypeDist, planned: d.planned.hookTypeDist },
      { title: '情绪定位', keys: EMOTIONS, written: d.written.emotionDist, planned: d.planned.emotionDist },
      { title: '场景分布', keys: SCENE_TYPES, written: d.written.sceneDist, planned: d.planned.sceneDist },
    ]
  }
  // 短篇：有 written（连续故事）才显示节奏分布（独立短篇无 written → 空）
  if (!d.written) return []
  return [
    { title: '钩子类型', keys: HOOK_TYPES, written: d.written.hookTypeDist, planned: {} },
    { title: '情绪定位', keys: EMOTIONS, written: d.written.emotionDist, planned: {} },
    { title: '场景分布', keys: SCENE_TYPES, written: d.written.sceneDist, planned: {} },
  ]
})
function distMax(g: DistGroup): number {
  return Math.max(1, ...g.keys.map((k) => Math.max(g.written[k] ?? 0, g.planned[k] ?? 0)))
}
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
              <span>继续写作 · 第{{ data.recentDoc.no }}{{ kind === 'long' ? '章' : '篇' }}</span>
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
            <span class="kpi-val">{{ chapters }}<small class="kpi-unit">{{ kind === 'long' ? '章' : '篇' }}</small></span>
            <span class="kpi-label">{{ kind === 'long' ? '章节' : '篇数' }}</span>
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
              :title="t.count ? `${t.date} · ${t.count} ${kind === 'long' ? '章' : '篇'}` : `${t.date} · 未${kind === 'long' ? '定稿' : '定稿'}`"
            ></span>
          </div>
          <div v-else class="heat-empty">
            <Flame :size="24" />
            <span>{{ kind === 'long' ? '写一章定稿后亮起' : '写一篇定稿后亮起' }}</span>
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

      <!-- ── ③ 字数曲线（面积图）─────────────────── -->
      <section v-if="rhythmData && curve.length" class="panel">
        <div class="panel-head">
          <TrendingUp :size="14" /> <span>字数曲线</span>
          <span class="head-legend">{{ curve.length }} {{ kind === 'long' ? '章' : '篇' }} · 均{{ kind === 'long' ? '章' : '篇' }} {{ curveAvg.toLocaleString() }} 字</span>
        </div>
        <div v-if="!curve.length" class="empty">{{ kind === 'long' ? '尚无已写章节' : '尚无已写篇目' }}</div>
        <svg
          v-else
          class="chart-svg"
          :viewBox="`0 0 ${CHART_W} ${CHART_H}`"
          preserveAspectRatio="xMidYMid meet"
          role="img"
          aria-label="字数曲线"
        >
          <defs>
            <linearGradient id="wordAreaGrad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" style="stop-color: var(--interactive-accent); stop-opacity: 0.2;" />
              <stop offset="100%" style="stop-color: var(--interactive-accent); stop-opacity: 0.01;" />
            </linearGradient>
          </defs>
          <!-- Y 轴实线网格 -->
          <g v-for="(t, idx) in Y_TICKS" :key="idx">
            <line :x1="PAD_LEFT" :x2="CHART_W" :y1="barY(maxWords * t)" :y2="barY(maxWords * t)" class="grid-line" />
            <text :x="PAD_LEFT - 8" :y="barY(maxWords * t) + 3" class="grid-label" text-anchor="end">{{ fmtWords(maxWords * t) }}</text>
          </g>
          <!-- 基线 -->
          <line :x1="PAD_LEFT" :x2="CHART_W" :y1="CHART_H - PAD_BOTTOM" :y2="CHART_H - PAD_BOTTOM" class="axis-baseline" />
          <!-- 面积填充 -->
          <path :d="wordAreaD" fill="url(#wordAreaGrad)" />
          <!-- 均篇参考线 -->
          <line :x1="PAD_LEFT" :x2="CHART_W" :y1="avgY" :y2="avgY" class="avg-line" />
          <text :x="CHART_W - 6" :y="avgY - 5" class="avg-text" text-anchor="end">均{{ kind === 'long' ? '章' : '篇' }} {{ fmtWords(curveAvg) }}</text>
          <!-- 折线 -->
          <path :d="wordLineD" class="word-line" />
          <!-- 端点 -->
          <circle
            v-for="(p, i) in curve"
            :key="p.no"
            :cx="ptX(i, curve.length)"
            :cy="barY(p.字数)"
            r="2.5"
            class="word-dot"
          >
            <title>第{{ p.no }}{{ kind === 'long' ? '章' : '篇' }} {{ p.标题 }} · {{ p.字数.toLocaleString() }} 字</title>
          </circle>
          <!-- X 轴编号（按 tickStep 降采样，长篇也保留横轴参照）-->
          <template v-for="(p, i) in curve" :key="'wl'+p.no">
            <text
              v-if="i % tickStep === 0"
              :x="ptX(i, curve.length)"
              :y="CHART_H - 8"
              class="axis-label-x"
              text-anchor="middle"
            >{{ p.no }}</text>
          </template>
        </svg>
      </section>

      <!-- ── 短篇画像缺口（短篇专属：情绪覆盖 + 反转覆盖 + 跨篇母题）── -->
      <section v-if="emotionGap || reversalGap || seriesMotifs.length" class="panel">
        <div class="panel-head">
          <BarChart3 :size="14" /> <span>画像缺口</span>
          <span v-if="emotionGap" class="head-legend">{{ emotionGap.filter((g) => !g.missing).length }}/{{ emotionGap.length }} 情绪已覆盖</span>
          <span v-if="reversalGap" class="head-legend">{{ reversalGap.filter((g) => !g.missing).length }}/{{ reversalGap.length }} 反转已覆盖</span>
        </div>
        <!-- 情绪覆盖 -->
        <div v-if="emotionGap" class="gap-rows">
          <div v-for="g in emotionGap" :key="g.emotion" class="gap-row" :class="{ 'is-missing': g.missing }">
            <span class="gap-label">{{ g.emotion }}</span>
            <div class="gap-bar">
              <div class="gap-fill" :style="{ width: Math.min(100, g.count * 25) + '%' }"></div>
            </div>
            <span class="gap-count" :class="{ 'is-zero': g.missing }">{{ g.count }} 篇</span>
          </div>
        </div>
        <!-- 反转类型覆盖 -->
        <div v-if="reversalGap" class="gap-rows">
          <div v-for="g in reversalGap" :key="g.type" class="gap-row" :class="{ 'is-missing': g.missing }">
            <span class="gap-label">{{ g.type }}</span>
            <div class="gap-bar">
              <div class="gap-fill" :style="{ width: Math.min(100, g.count * 25) + '%' }"></div>
            </div>
            <span class="gap-count" :class="{ 'is-zero': g.missing }">{{ g.count }} 篇</span>
          </div>
          <div v-if="reversalUnrecognized > 0" class="gap-unrecognized">
            <Info :size="12" /> {{ reversalUnrecognized }} 篇未归类（规则未命中 / 池外类型）
          </div>
        </div>
        <!-- 跨篇母题 -->
        <div v-if="seriesMotifs.length" class="motif-section">
          <span class="motif-label">跨篇母题</span>
          <div class="motif-tags">
            <span v-for="m in seriesMotifs" :key="m" class="motif-tag">{{ m }}</span>
          </div>
        </div>
      </section>

      <!-- ── ④ 节奏分布（emphasis：已写=accent，规划=灰）── -->
      <section v-if="distGroups.length" class="panel">
        <div class="panel-head">
          <BarChart3 :size="14" /> <span>节奏分布</span>
          <span v-if="rhythmData?.kind === 'long'" class="head-legend">柱 已写 · 线 规划 · {{ rhythmData.written.count }}/{{ rhythmData.planned.count }} 章</span>
          <span v-else class="head-legend">柱 已写 · {{ rhythmData?.written?.count ?? 0 }} 篇</span>
        </div>
        <div class="dist-grid">
          <div v-for="g in distGroups" :key="g.title" class="dist-group">
            <div class="dist-title">{{ g.title }}</div>
            <div v-for="k in g.keys" :key="k" class="dist-row">
              <span class="dist-key">{{ k }}</span>
              <div class="dist-bar">
                <div class="dist-written" :style="{ width: ((g.written[k] ?? 0) / distMax(g) * 100) + '%' }"></div>
                <div
                  v-if="(g.planned[k] ?? 0) > 0"
                  class="dist-target"
                  :style="{ left: ((g.planned[k] ?? 0) / distMax(g) * 100) + '%' }"
                ></div>
              </div>
              <span class="dist-val">{{ g.written[k] ?? 0 }}<span class="sep">/</span>{{ g.planned[k] ?? 0 }}</span>
            </div>
          </div>
        </div>
      </section>

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
  animation: fade-up var(--dur-fast) var(--ease-out) both;
}
.panel-head {
  display: flex; align-items: center; gap: 6px;
  font-size: var(--font-size-s); font-weight: 600;
  color: var(--text-muted); margin-bottom: 14px;
}
.panel-head svg { opacity: 0.5; flex-shrink: 0; }
.head-legend { margin-left: auto; font-weight: 400; font-size: var(--font-size-xs); color: var(--text-muted); }
.empty { font-size: var(--font-size-s); color: var(--text-faint); padding: var(--size-4-2) 0; }

/* stagger */
.hero { animation: fade-up 0.5s var(--ease-out) both; }
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

/* ══ ③ 字数曲线 SVG（面积图）══ */
.chart-svg { width: 100%; height: auto; display: block; }
.grid-line { stroke: var(--background-modifier-border); stroke-width: 1; }
.axis-baseline { stroke: var(--background-modifier-border); stroke-width: 1; }
.grid-label { fill: var(--text-faint); font-size: var(--font-size-xxs); font-variant-numeric: tabular-nums; }
.axis-label-x { fill: var(--text-faint); font-size: 9px; }
.word-line { fill: none; stroke: var(--interactive-accent); stroke-width: 2; stroke-linejoin: round; stroke-linecap: round; }
.word-dot { fill: var(--interactive-accent); stroke: var(--background-primary); stroke-width: 1.5; }
.avg-line { stroke: var(--text-faint); stroke-width: 1; stroke-dasharray: 4 3; opacity: 0.6; }
.avg-text { fill: var(--text-faint); font-size: var(--font-size-xxs); }

/* ══ 短篇画像缺口 ══ */
.gap-rows { display: flex; flex-direction: column; gap: 8px; }
.gap-row { display: grid; grid-template-columns: 72px 1fr 44px; align-items: center; gap: var(--size-4-2); }
.gap-label { font-size: var(--font-size-xs); color: var(--text-muted); }
.gap-bar { position: relative; height: 8px; background: color-mix(in srgb, var(--background-modifier-border) 50%, transparent); border-radius: 4px; }
.gap-fill { height: 100%; background: var(--interactive-accent); border-radius: 4px; transition: width var(--dur-slow) var(--ease-out); }
.gap-row.is-missing .gap-fill { background: var(--text-warning); box-shadow: 0 0 6px color-mix(in srgb, var(--text-warning) 40%, transparent); }
.gap-count { font-size: var(--font-size-xs); color: var(--text-faint); text-align: right; font-variant-numeric: tabular-nums; }
.gap-count.is-zero { color: var(--text-warning); font-weight: 600; }
.gap-unrecognized { display: flex; align-items: center; gap: 4px; font-size: var(--font-size-xxs); color: var(--text-faint); margin-top: 2px; }
.motif-section { margin-top: 14px; display: flex; align-items: center; gap: var(--size-4-2); }
.motif-label { font-size: var(--font-size-xs); color: var(--text-faint); flex-shrink: 0; }
.motif-tags { display: flex; flex-wrap: wrap; gap: 4px; }
.motif-tag { font-size: var(--font-size-xs); padding: 1px 10px; border-radius: 8px; background: color-mix(in srgb, var(--interactive-accent) 10%, transparent); color: var(--text-accent); }

/* ══ ④ 节奏分布 ══ */
.dist-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: var(--size-4-5); }
.dist-group { display: flex; flex-direction: column; gap: 8px; }
.dist-title { font-size: var(--font-size-s); font-weight: 600; color: var(--text-normal); padding-bottom: 6px; margin-bottom: 2px; border-bottom: 1px solid var(--background-modifier-border); }
.dist-row { display: grid; grid-template-columns: 56px 1fr 38px; align-items: center; gap: var(--size-4-2); }
.dist-key { font-size: var(--font-size-xs); color: var(--text-muted); }
.dist-bar { position: relative; height: 14px; display: flex; align-items: center; background: color-mix(in srgb, var(--background-modifier-border) 50%, transparent); border-radius: 4px; }
.dist-written { height: 8px; background: var(--interactive-accent); border-radius: 3px; transition: width var(--dur-slow) var(--ease-out); }
.dist-target { position: absolute; top: 0; bottom: 0; width: 2px; background: var(--text-muted); border-radius: 1px; transform: translateX(-1px); }
.dist-val { font-size: var(--font-size-xs); color: var(--text-faint); text-align: right; font-variant-numeric: tabular-nums; }
.dist-val .sep { margin: 0 2px; opacity: 0.5; }

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
@keyframes fade-up { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: none; } }

/* ══ 杂项 ══ */
.ov-placeholder { padding: 80px 0; text-align: center; color: var(--text-faint); font-size: var(--font-size-m); }
.ov-err { padding: 40px; text-align: center; color: var(--text-error); font-size: var(--font-size-m); }
.btn-retry { margin-left: 8px; padding: 4px 12px; font-size: var(--font-size-s); border: 1px solid var(--background-modifier-border); border-radius: var(--radius-s); background: var(--background-primary); color: var(--text-normal); cursor: pointer; }

/* 窄屏 */
@media (max-width: 600px) {
  .hero-ring { display: none; }
  .bento-2 { grid-template-columns: 1fr; }
  .dist-grid { grid-template-columns: 1fr; }
  .hero-kpis { flex-wrap: wrap; }
  .kpi { flex: 1 1 40%; }
  .kpi + .kpi::before { display: none; }
}
</style>
