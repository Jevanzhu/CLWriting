<script setup lang="ts">
/**
 * 篇详情（#6.5，短篇专属）：顶部元数据 + 左正文只读 + 右清单三段。
 *
 * 清单三段（数据源 篇/N-T/清单.md，内核 readPieceList 现成）：
 *   ① 情绪曲线（P0 主图：强度折线 1-10，峰值高亮）
 *   ② 反转线索表（核心反转置顶 + 铺垫点列表）
 *   ③ 伏笔回收（列表，未回收红标）
 *
 * 正文只读对照（编辑跳 /edit，已能编辑 正文.md/清单.md，避免重复造编辑器）。
 */
import { ref, computed, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import BookTabs from '../components/BookTabs.vue'
import EChart from '../components/EChart.vue'
import type { EChartsOption, LineSeriesOption } from 'echarts'

interface PieceSummary {
  篇号: number
  标题: string
  字数: number
  目标情绪?: string
  核心反转?: string
}
interface EmotionPoint {
  段落: string
  情绪: string
  强度: number
  说明?: string
}
interface SetupPoint {
  位置: string
  内容: string
}
interface PayoffEntry {
  伏笔: string
  回收位置: string
  未回收?: boolean
}
interface PieceListData {
  反转线索表: { 核心反转: string; 铺垫点: SetupPoint[] }
  情绪曲线?: EmotionPoint[]
  伏笔回收: PayoffEntry[]
}
interface PieceDetailData {
  meta: PieceSummary
  body: string
  list: PieceListData
}

const route = useRoute()
const router = useRouter()
const name = computed(() => (typeof route.params.name === 'string' ? route.params.name : ''))
const no = computed(() => Number(route.params.no))

const data = ref<PieceDetailData | null>(null)
const pieces = ref<PieceSummary[]>([])
const loading = ref(true)
const error = ref('')

async function loadDetail(n: string, pieceNo: number): Promise<void> {
  loading.value = true
  error.value = ''
  data.value = null
  try {
    const r = await fetch(`/api/books/${encodeURIComponent(n)}/piece/${pieceNo}`)
    const d = (await r.json().catch(() => ({}))) as PieceDetailData & { error?: string }
    if (!r.ok) throw new Error(d.error ?? `HTTP ${r.status}`)
    data.value = d
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    loading.value = false
  }
}

async function loadPieces(n: string): Promise<void> {
  try {
    const r = await fetch(`/api/books/${encodeURIComponent(n)}/pieces`)
    const d = (await r.json().catch(() => ({}))) as { pieces?: PieceSummary[]; error?: string }
    if (r.ok && d.pieces) pieces.value = d.pieces
  } catch {
    /* 翻页器可选，失败不阻塞 */
  }
}

watch(
  () => [route.params.name, route.params.no] as const,
  ([n, pno]) => {
    if (typeof n === 'string' && typeof pno === 'string') {
      loadDetail(n, Number(pno))
      if (pieces.value.length === 0) loadPieces(n)
    }
  },
  { immediate: true },
)

/** 翻页：篇列表里相邻篇号 */
const noIndex = computed(() => pieces.value.findIndex((p) => p.篇号 === no.value))
function go(delta: number): void {
  const i = noIndex.value
  if (i < 0) return
  const target = pieces.value[i + delta]
  if (target) router.push(`/books/${encodeURIComponent(name.value)}/piece/${target.篇号}`)
}

/** 正文按 ## 段落标题分段（只读对照） */
const proseSections = computed<{ title: string; text: string }[]>(() => {
  const body = (data.value?.body ?? '').trim()
  if (!body) return []
  const sections: { title: string; text: string }[] = []
  let cur: { title: string; text: string } | null = null
  for (const line of body.split('\n')) {
    const m = line.match(/^##\s+(.*)$/)
    if (m) {
      if (cur) sections.push(cur)
      cur = { title: m[1]!.trim(), text: '' }
    } else if (cur) {
      cur.text += (cur.text ? '\n' : '') + line
    }
  }
  if (cur) sections.push(cur)
  // 无 ## 标题的裸正文：整体作一段
  if (sections.length === 0 && body) return [{ title: '', text: body }]
  return sections.map((s) => ({ title: s.title, text: s.text.trim() }))
})

/** 情绪曲线（P0 主图）：强度折线 1-10，峰值高亮 */
const emotionOption = computed<EChartsOption | null>(() => {
  const curve = data.value?.list.情绪曲线 ?? []
  if (curve.length === 0) return null
  const peak = Math.max(...curve.map((p) => p.强度))
  const series: LineSeriesOption[] = [
    {
      type: 'line',
      smooth: true,
      data: curve.map((p) => ({
        value: p.强度,
        name: p.情绪,
        段落: p.段落,
        说明: p.说明,
        itemStyle: { color: p.强度 === peak ? '#ef4444' : '#3b82f6' },
        symbolSize: p.强度 === peak ? 14 : 8,
      })),
      label: { show: true, formatter: (p) => (p.data as { name: string }).name, fontSize: 11, color: '#374151' },
      lineStyle: { color: '#3b82f6', width: 2 },
      areaStyle: { opacity: 0.08 },
      markPoint: curve.length > 1 ? { data: [{ type: 'max', name: '峰值' }], symbolSize: 0 } : undefined,
    },
  ]
  return {
    tooltip: {
      trigger: 'axis',
      formatter: (params) => {
        const d = (params as { data?: { 段落?: string; name?: string; 说明?: string; value?: number } }[])[0]?.data
        const note = d?.说明 ? `（${d.说明}）` : ''
        return d ? `【${d.段落}】${d.name} ${d.value}/10${note}` : ''
      },
    },
    grid: { left: 40, right: 24, top: 28, bottom: 40 },
    xAxis: { type: 'category', data: curve.map((p) => p.段落), axisLabel: { interval: 0, fontSize: 11 } },
    yAxis: { type: 'value', min: 0, max: 10, name: '强度', interval: 2 },
    series,
  }
})
</script>

<template>
  <section class="piece-page">
    <BookTabs :name="name" active="piece" />

    <!-- 顶部：返回 + 篇导航 + 元数据 -->
    <div class="piece-head">
      <div class="head-row">
        <button class="btn-back" @click="router.push(`/books/${encodeURIComponent(name)}/rhythm`)">← 返回节奏页</button>
        <div class="pager">
          <button class="btn-small" :disabled="noIndex <= 0" @click="go(-1)">← 上一篇</button>
          <span class="pager-no">第 {{ no }} 篇</span>
          <button class="btn-small" :disabled="noIndex < 0 || noIndex >= pieces.length - 1" @click="go(1)">下一篇 →</button>
        </div>
      </div>

      <p v-if="loading" class="hint">加载中…</p>
      <p v-else-if="error" class="hint error">加载失败：{{ error }}</p>

      <article v-if="data" class="meta-card">
        <div class="meta-title">
          <span class="meta-no">第 {{ data.meta.篇号 }} 篇</span>
          <span class="meta-name">{{ data.meta.标题 }}</span>
        </div>
        <div class="meta-fields">
          <span v-if="data.meta.目标情绪" class="chip">🎯 目标情绪：{{ data.meta.目标情绪 }}</span>
          <span class="chip">📏 {{ data.meta.字数 }} 字</span>
          <RouterLink class="edit-link" :to="`/books/${encodeURIComponent(name)}/edit`">编辑此篇 ✏️</RouterLink>
        </div>
        <p v-if="data.meta.核心反转" class="meta-reversal">
          <span class="reversal-label">核心反转</span>{{ data.meta.核心反转 }}
        </p>
      </article>
    </div>

    <!-- 主体：左正文 + 右清单 -->
    <div v-if="data" class="main-grid">
      <!-- 左：正文只读 -->
      <article class="card prose-card">
        <h3 class="block-title">正文（只读对照）</h3>
        <div class="prose-body">
          <div v-for="(s, i) in proseSections" :key="i" class="prose-sec">
            <h4 v-if="s.title" class="prose-h">{{ s.title }}</h4>
            <p v-for="(para, j) in s.text.split(/\n+/).filter(Boolean)" :key="j" class="prose-p">{{ para }}</p>
          </div>
          <p v-if="proseSections.length === 0" class="hint">（无正文）</p>
        </div>
      </article>

      <!-- 右：清单三段 -->
      <div class="list-col">
        <!-- ① 情绪曲线（P0 主图） -->
        <article class="card">
          <h3 class="block-title">情绪曲线</h3>
          <EChart v-if="emotionOption" :option="emotionOption" />
          <p v-else class="hint">（清单无情绪曲线）</p>
        </article>

        <!-- ② 反转线索表 -->
        <article class="card">
          <h3 class="block-title">反转线索表</h3>
          <div class="reversal-core">
            <span class="reversal-label">核心反转</span>
            <span>{{ data.list.反转线索表.核心反转 || '（待补）' }}</span>
          </div>
          <ul v-if="data.list.反转线索表.铺垫点.length" class="setup-list">
            <li v-for="(p, i) in data.list.反转线索表.铺垫点" :key="i">
              <span class="setup-pos">[{{ p.位置 }}]</span>{{ p.内容 }}
            </li>
          </ul>
          <p v-else class="hint">（无铺垫点，建议 ≥3）</p>
        </article>

        <!-- ③ 伏笔回收 -->
        <article class="card">
          <h3 class="block-title">伏笔回收</h3>
          <ul v-if="data.list.伏笔回收.length" class="payoff-list">
            <li v-for="(e, i) in data.list.伏笔回收" :key="i" :class="{ unresolved: e.未回收 }">
              <span class="payoff-name">{{ e.伏笔 }}</span>
              <span v-if="e.未回收" class="tag-red">未回收</span>
              <span v-else class="payoff-at">→ 回收于 {{ e.回收位置 }}</span>
            </li>
          </ul>
          <p v-else class="hint">（无伏笔）</p>
        </article>
      </div>
    </div>
  </section>
</template>

<style scoped>
.piece-page {
  max-width: 1080px;
  margin: 0 auto;
}
.piece-head {
  margin-bottom: 16px;
}
.head-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 12px;
}
.btn-back {
  padding: 6px 14px;
  border: 1px solid #d1d5db;
  border-radius: 6px;
  background: #fff;
  cursor: pointer;
  font-size: 13px;
}
.btn-back:hover {
  border-color: #3b82f6;
}
.pager {
  display: flex;
  align-items: center;
  gap: 8px;
}
.btn-small {
  padding: 4px 10px;
  border: 1px solid #d1d5db;
  border-radius: 6px;
  background: #fff;
  cursor: pointer;
  font-size: 13px;
}
.btn-small:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
.pager-no {
  font-size: 14px;
  font-weight: 600;
  color: #374151;
}
.card {
  background: #fff;
  border: 1px solid #e5e7eb;
  border-radius: 8px;
  padding: 16px 20px;
}
.block-title {
  margin: 0 0 10px;
  font-size: 13px;
  font-weight: 600;
  color: #6b7280;
  letter-spacing: 0.04em;
}
.meta-card {
  background: #f0f7ff;
  border: 1px solid #bfdbfe;
  border-radius: 8px;
  padding: 14px 18px;
}
.meta-title {
  display: flex;
  align-items: baseline;
  gap: 12px;
  margin-bottom: 8px;
}
.meta-no {
  font-size: 13px;
  color: #3b82f6;
  font-weight: 600;
}
.meta-name {
  font-size: 18px;
  font-weight: 700;
  color: #111827;
}
.meta-fields {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
}
.chip {
  display: inline-block;
  padding: 3px 10px;
  background: #fff;
  border: 1px solid #dbeafe;
  border-radius: 12px;
  font-size: 12px;
  color: #1e40af;
}
.edit-link {
  margin-left: auto;
  font-size: 13px;
  color: #3b82f6;
  text-decoration: none;
}
.edit-link:hover {
  text-decoration: underline;
}
.meta-reversal {
  margin: 10px 0 0;
  font-size: 14px;
  color: #1e3a8a;
  line-height: 1.6;
}
.reversal-label {
  display: inline-block;
  padding: 2px 8px;
  margin-right: 8px;
  background: #fbbf24;
  color: #78350f;
  border-radius: 4px;
  font-size: 11px;
  font-weight: 600;
  vertical-align: middle;
}
.main-grid {
  display: grid;
  grid-template-columns: 1.3fr 1fr;
  gap: 16px;
  align-items: start;
}
.prose-card {
  position: sticky;
  top: 12px;
  max-height: calc(100vh - 140px);
  overflow-y: auto;
}
.prose-body {
  font-size: 15px;
  line-height: 1.85;
  color: #1f2937;
}
.prose-sec + .prose-sec {
  margin-top: 12px;
}
.prose-h {
  margin: 0 0 6px;
  font-size: 13px;
  font-weight: 600;
  color: #9ca3af;
  letter-spacing: 0.05em;
}
.prose-p {
  margin: 0 0 10px;
}
.list-col {
  display: grid;
  gap: 16px;
}
.reversal-core {
  display: flex;
  gap: 8px;
  align-items: flex-start;
  padding: 10px 12px;
  background: #fffbeb;
  border: 1px solid #fde68a;
  border-radius: 6px;
  font-size: 14px;
  color: #1f2937;
  line-height: 1.6;
  margin-bottom: 10px;
}
.setup-list,
.payoff-list {
  margin: 0;
  padding: 0;
  list-style: none;
  display: grid;
  gap: 8px;
}
.setup-list li {
  padding: 8px 10px;
  background: #f9fafb;
  border-radius: 6px;
  font-size: 13px;
  color: #374151;
  line-height: 1.5;
}
.setup-pos {
  display: inline-block;
  margin-right: 6px;
  padding: 1px 6px;
  background: #e0e7ff;
  color: #3730a3;
  border-radius: 3px;
  font-size: 11px;
  font-weight: 600;
}
.payoff-list li {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  padding: 8px 10px;
  background: #f9fafb;
  border-radius: 6px;
  font-size: 13px;
}
.payoff-list li.unresolved {
  background: #fef2f2;
  border: 1px solid #fecaca;
}
.payoff-name {
  color: #111827;
}
.payoff-at {
  color: #6b7280;
}
.tag-red {
  margin-left: auto;
  padding: 1px 8px;
  background: #dc2626;
  color: #fff;
  border-radius: 10px;
  font-size: 11px;
  font-weight: 600;
}
.hint {
  color: #9ca3af;
  font-size: 13px;
  margin: 4px 0;
}
.hint.error {
  color: #dc2626;
}
</style>
