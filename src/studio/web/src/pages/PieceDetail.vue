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
import EChart from '../components/EChart.vue'
import type { EChartsOption, LineSeriesOption } from 'echarts'
import type { PieceDetailData, PieceSummary } from '../types'
import { getPiece, listPieces } from '../api/books'

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
    data.value = await getPiece(n, pieceNo)
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    loading.value = false
  }
}

async function loadPieces(n: string): Promise<void> {
  try {
    pieces.value = await listPieces(n)
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
        itemStyle: { color: p.强度 === peak ? 'var(--cinnabar)' : 'var(--ink-cyan)' },
        symbolSize: p.强度 === peak ? 14 : 8,
      })),
      label: { show: true, formatter: (p) => (p.data as { name: string }).name, fontSize: 11, color: 'var(--ink)' },
      lineStyle: { color: 'var(--ink-cyan)', width: 2 },
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
    <div class="bento-wrap">
      <!-- 顶部：返回 + 篇导航 -->
      <div class="head-row">
        <button class="btn" @click="router.push(`/books/${encodeURIComponent(name)}/rhythm`)">← 返回节奏页</button>
        <div class="pager">
          <button class="btn" :disabled="noIndex <= 0" @click="go(-1)">← 上一篇</button>
          <span class="pager-no">第 {{ no }} 篇</span>
          <button class="btn" :disabled="noIndex < 0 || noIndex >= pieces.length - 1" @click="go(1)">下一篇 →</button>
        </div>
      </div>

      <p v-if="loading" class="hint">加载中…</p>
      <p v-else-if="error" class="hint error">加载失败：{{ error }}</p>

      <template v-if="data">
        <div class="bento-head">
          <h1 class="bento-title">第 {{ data.meta.篇号 }} 篇 · {{ data.meta.标题 }}</h1>
          <div class="bento-sub">
            <span v-if="data.meta.目标情绪" class="meta-chip">🎯 {{ data.meta.目标情绪 }}</span>
            <span class="meta-chip">📏 {{ data.meta.字数 }} 字</span>
            <RouterLink class="edit-link" :to="`/books/${encodeURIComponent(name)}/edit`">编辑此篇 ✏️</RouterLink>
          </div>
        </div>
        <div v-if="data.meta.核心反转" class="meta-reversal">
          <span class="tag yellow">核心反转</span>
          <span>{{ data.meta.核心反转 }}</span>
        </div>

        <!-- 主体：左正文 + 右清单 -->
        <div class="main-grid">
          <article class="bento-card prose-card">
            <div class="bc-label">正文（只读对照）</div>
            <div class="prose">
              <div v-for="(s, i) in proseSections" :key="i">
                <h4 v-if="s.title" class="prose-sub">{{ s.title }}</h4>
                <p v-for="(para, j) in s.text.split(/\n+/).filter(Boolean)" :key="j">{{ para }}</p>
              </div>
              <p v-if="proseSections.length === 0" class="hint">（无正文）</p>
            </div>
          </article>

          <div class="list-col">
            <article class="bento-card">
              <div class="bc-label">情绪曲线</div>
              <EChart v-if="emotionOption" :option="emotionOption" />
              <p v-else class="hint">（清单无情绪曲线）</p>
            </article>
            <article class="bento-card">
              <div class="bc-label">反转线索表</div>
              <div class="reversal-core">
                <span class="tag yellow">核心反转</span>
                <span>{{ data.list.反转线索表.核心反转 || '（待补）' }}</span>
              </div>
              <div v-if="data.list.反转线索表.铺垫点.length">
                <div v-for="(p, i) in data.list.反转线索表.铺垫点" :key="i" class="ledger-item">
                  <span class="setup-pos">{{ p.位置 }}</span>
                  <div>{{ p.内容 }}</div>
                </div>
              </div>
              <p v-else class="hint">（无铺垫点，建议 ≥3）</p>
            </article>
            <article class="bento-card">
              <div class="bc-label">伏笔回收</div>
              <div v-if="data.list.伏笔回收.length">
                <div v-for="(e, i) in data.list.伏笔回收" :key="i" class="ledger-item" :class="{ unresolved: e.未回收 }">
                  <span class="clw-dot" :class="e.未回收 ? 'red' : 'green'"></span>
                  <div><b>{{ e.伏笔 }}</b><div class="desc">{{ e.未回收 ? '未回收' : `回收于 ${e.回收位置}` }}</div></div>
                </div>
              </div>
              <p v-else class="hint">（无伏笔）</p>
            </article>
          </div>
        </div>
      </template>
    </div>
  </section>
</template>

<style scoped>
.piece-page {
  margin: 0 auto;
}
.piece-page .bento-card{min-height:auto;padding:14px 16px}
.head-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 14px;
}
.pager {
  display: flex;
  align-items: center;
  gap: 8px;
}
.pager-no {
  font-size: 13px;
  font-weight: 600;
  color: var(--ink);
}
.meta-card {
  background: var(--active-bg);
  border-color: var(--active-bg);
}
.meta-title {
  display: flex;
  align-items: baseline;
  gap: 10px;
  flex-wrap: wrap;
  margin-bottom: 6px;
}
.meta-no {
  font-size: 12px;
  color: var(--ink-cyan);
  font-weight: 600;
}
.meta-name {
  font-size: 18px;
  font-weight: 700;
  color: var(--ink);
}
.meta-fields {
  display: flex;
  gap: 6px;
  align-items: center;
  margin-left: auto;
}
.edit-link {
  margin-left: 8px;
  font-size: 12px;
  color: var(--ink-cyan);
  text-decoration: none;
}
.edit-link:hover {
  text-decoration: underline;
}
.meta-reversal {
  margin: 8px 0 0;
  font-size: 13px;
  color: var(--ink);
  line-height: 1.6;
  display: flex;
  gap: 8px;
  align-items: flex-start;
}
.main-grid {
  display: grid;
  grid-template-columns: 1.3fr 1fr;
  gap: 12px;
  align-items: start;
  margin-top: 12px;
}
.prose-card {
  position: sticky;
  top: 12px;
  max-height: calc(100vh - 140px);
  overflow-y: auto;
}
.prose-sub {
  margin: 14px 0 6px;
  font-size: 12px;
  font-weight: 600;
  color: var(--text-3);
  letter-spacing: 0.05em;
  text-indent: 0;
}
.prose p {
  margin: 0 0 12px;
}
.list-col {
  display: grid;
  gap: 12px;
}
.reversal-core {
  display: flex;
  gap: 8px;
  align-items: flex-start;
  padding: 10px 12px;
  background: var(--warn-bg);
  border-radius: 7px;
  font-size: 13px;
  color: var(--ink);
  line-height: 1.6;
  margin-bottom: 8px;
}
.setup-pos {
  display: inline-block;
  margin-right: 4px;
  padding: 1px 6px;
  background: var(--active-bg);
  color: var(--ochre);
  border-radius: 3px;
  font-size: 10px;
  font-weight: 600;
  flex-shrink: 0;
}
.ledger-item.unresolved b {
  color: var(--cinnabar);
}
.piece-page :deep(.echart) {
  height: 200px;
}
.piece-page .hint {
  color: var(--text-3);
  font-size: 13px;
  margin: 4px 0;
}
.piece-page .hint.error {
  color: var(--cinnabar);
}
</style>
