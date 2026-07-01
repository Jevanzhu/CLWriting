<script setup lang="ts">
// 作品概要（总览态中栏 o1）：Bento 便当盒网格，对齐 mockup v5 renderOvMid o1。
// 数据 GET /overview（identity/progress/state/volumes/timeline 全真实）。
import { ref, watch, computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import EChart from '../components/EChart.vue'
import type { EChartsOption } from 'echarts'
import type { BookOverview } from '../types'
import { getOverview } from '../api/books'

const route = useRoute()
const router = useRouter()
const name = computed(() => (typeof route.params.name === 'string' ? route.params.name : ''))
const data = ref<BookOverview | null>(null)
const loading = ref(true)
const error = ref('')

async function load(n: string): Promise<void> {
  loading.value = true
  error.value = ''
  data.value = null
  try {
    data.value = await getOverview(n)
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

function fmtDate(iso?: string): string {
  if (!iso) return '—'
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString('zh-CN')
}

function hostLabel(host: string): string {
  return host === 'codex' ? 'Codex' : 'Claude Code'
}

function fmtWords(n: number): string {
  if (n <= 0) return '0'
  if (n < 10000) return `${n}`
  return `${(n / 10000).toFixed(1)} 万`
}

function stateHint(s: BookOverview['state']): string {
  const d = (s.detail ?? {}) as Record<string, unknown>
  switch (s.state) {
    case 7: {
      const next = d['nextChapter']
      return typeof next === 'number' ? `起草第 ${next} 章` : '准备起草新章'
    }
    case 8: return '有章节待批量审稿'
    case 5: return '当前卷已写完,待开新卷'
    case 6: return '体检周期到期,建议先体检'
    case 4: return '工作区有未完成内容'
    case 3: {
      const h = d['handEdits']
      return Array.isArray(h) ? `${h.length} 处手改未入账` : '有手改未入账'
    }
    case 2: return '源文件解析有错'
    case 1: return 'git 仓库需要检查'
    default: return ''
  }
}

function canWrite(s: BookOverview['state']): boolean {
  return s.state === 7 || s.state === 5 || s.state === 8
}

/** 完成度% */
const pct = computed(() => {
  const p = data.value?.progress
  if (!p) return 0
  if (typeof p.percent === 'number') return Math.min(p.percent, 100)
  if (p.targetWords && p.targetWords > 0) return Math.min(Math.round((p.words / p.targetWords) * 100), 100)
  return 0
})

const ringStyle = computed(
  () => `background:conic-gradient(var(--ink-cyan) 0 ${pct.value}%,var(--border-55) ${pct.value}% 100%)`,
)

/** 近 N 日字数柱状（取 timeline 末 7 条） */
const weekBars = computed(() => {
  const tl = data.value?.timeline ?? []
  const recent = tl.slice(-7)
  const max = Math.max(...recent.map((t) => t.count), 1)
  return recent.map((t) => ({
    date: t.date.slice(5),
    count: t.count,
    h: Math.max((t.count / max) * 100, t.count > 0 ? 6 : 2),
  }))
})

function onWrite(): void {
  router.push(`/books/${encodeURIComponent(name.value)}/edit`)
}
function goHealth(): void {
  router.push(`/books/${encodeURIComponent(name.value)}/health`)
}

/** 写作热力（全年定稿日历） */
const heatOption = computed<EChartsOption | null>(() => {
  const tl = data.value?.timeline ?? []
  if (tl.length === 0) return null
  const year = new Date().getFullYear()
  const max = Math.max(...tl.map((t) => t.count), 1)
  const unit = data.value?.identity.kind === 'short' ? '篇' : '章'
  return {
    tooltip: { formatter: (p) => { const d = (p as { data?: [string, number] }).data; return d ? `${d[0]}：${d[1]} ${unit}` : '' } },
    visualMap: { show: false, min: 0, max, inRange: { color: ['var(--border)', 'var(--active-bg)', 'var(--ink-cyan)'] } },
    calendar: {
      range: String(year), cellSize: ['auto', 13], left: 30, right: 20,
      itemStyle: { borderWidth: 2, borderColor: 'var(--panel)' },
      yearLabel: { show: false }, dayLabel: { firstDay: 1, nameMap: 'ZH' }, monthLabel: { nameMap: 'ZH' },
    },
    series: [{ type: 'heatmap', coordinateSystem: 'calendar', data: tl.map((t) => [t.date, t.count] as [string, number]) }],
  }
})
</script>

<template>
  <section class="book-detail">
    <p v-if="loading" class="bento-wrap hint">加载中…</p>
    <p v-else-if="error" class="bento-wrap hint error">加载失败：{{ error }}</p>
    <template v-else-if="data">
      <div class="bento-wrap">
        <div class="bento-head">
          <h1 class="bento-title">{{ data.identity.title }} · 作品概要</h1>
          <div class="bento-sub">
            <span class="meta-chip">{{ data.identity.genre || '未分类' }}</span>
            <span class="meta-chip">{{ data.state.name }}</span>
            <span class="meta-chip">共 {{ data.progress.chapters }} {{ data.identity.kind === 'short' ? '篇' : '章' }}</span>
            <span class="meta-chip">{{ hostLabel(data.identity.host) }}</span>
          </div>
        </div>

        <div class="bento-grid">
          <!-- 总体完成度（大卡 · 环）-->
          <div class="bento-card bento-lg">
            <div class="bc-menu" title="操作">⋮</div>
            <div class="bc-label">总体完成度</div>
            <div class="bc-ring" :style="ringStyle">
              <span>{{ pct }}<span>%</span></span>
            </div>
            <div class="bc-foot">{{ fmtWords(data.progress.words) }} 字 · 目标 {{ fmtWords(data.progress.targetWords ?? 0) }} 字 · {{ data.state.name }}</div>
            <div class="bc-progress"><div :style="{ width: pct + '%' }"></div></div>
          </div>

          <!-- 总字数 -->
          <div class="bento-card">
            <div class="bc-menu" title="操作">⋮</div>
            <div class="bc-label">总字数</div>
            <div class="bc-stat">{{ fmtWords(data.progress.words) }}</div>
          </div>

          <!-- 章节进度 -->
          <div class="bento-card">
            <div class="bc-menu" title="操作">⋮</div>
            <div class="bc-label">{{ data.identity.kind === 'short' ? '篇数' : '章节进度' }}</div>
            <div class="bc-stat">{{ data.progress.chapters }}</div>
          </div>

          <!-- 写作位置 -->
          <div class="bento-card">
            <div class="bc-menu" title="操作">⋮</div>
            <div class="bc-label">写作位置</div>
            <div class="bc-stat" style="font-size:15px;line-height:1.3">{{ data.state.name }}</div>
            <div class="bc-sub">{{ stateHint(data.state) || '状态就绪' }}</div>
          </div>

          <!-- 近 N 日字数（大卡 · 柱状）-->
          <div v-if="weekBars.length" class="bento-card bento-lg">
            <div class="bc-menu" title="操作">⋮</div>
            <div class="bc-label">近 {{ weekBars.length }} 日字数</div>
            <div class="bc-bars" style="height:120px">
              <div
                v-for="(b, i) in weekBars"
                :key="i"
                class="bc-bar"
                :style="{ height: b.h + '%' }"
                :title="`${b.date} · ${b.count} 字`"
              ></div>
            </div>
            <div class="bc-bars-labels">
              <span v-for="(b, i) in weekBars" :key="i">{{ b.date }}</span>
            </div>
          </div>

          <!-- 快速操作 -->
          <div class="bento-card bento-action">
            <div class="bc-label">快速操作</div>
            <div class="bc-btns">
              <button class="neo-btn" :disabled="!canWrite(data.state)" @click="onWrite">✍ 继续写作</button>
              <button class="neo-btn" @click="goHealth">🩺 体检</button>
            </div>
          </div>

          <!-- 卷结构（长篇）-->
          <div v-if="data.identity.kind === 'long' && data.volumes.length" class="bento-card bento-c2 bento-r2 scroll">
            <div class="bc-label">卷结构 · {{ data.volumes.length }}</div>
            <div class="bc-list">
              <div v-for="v in data.volumes" :key="v.path" class="bc-list-row"><span>{{ v.name }}</span></div>
            </div>
          </div>

          <!-- 写作热力（全年）-->
          <div v-if="heatOption" class="bento-card bento-full">
            <div class="bc-label">写作热力 · {{ new Date().getFullYear() }} 年定稿</div>
            <EChart :option="heatOption" />
          </div>
        </div>
      </div>
    </template>
  </section>
</template>

<style scoped>
.book-detail{margin:0 auto}
.book-detail :deep(.echart){height:150px}
.book-detail .hint{color:var(--text-2);padding-top:40px}
.book-detail .hint.error{color:var(--cinnabar)}
</style>
