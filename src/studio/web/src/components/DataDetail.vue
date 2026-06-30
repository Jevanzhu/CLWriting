<script setup lang="ts">
// 总览右栏（对齐 mockup renderOvRight）：按当前总览页显示对应摘要 / 导航卡。
// o1 关键指标（getOverview）/ a_piece 篇列表（listPieces，可切篇）/ a_ledger 账本条目（getLeads）；
// health/rhythm/settings 中栏已有全量图表，右栏给提示。
import { ref, computed, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { getOverview, listPieces, getLeads } from '../api/books'
import type { BookOverview, PieceSummary, LeadsData } from '../types'

const route = useRoute()
const router = useRouter()
const name = computed(() => (typeof route.params.name === 'string' ? route.params.name : ''))
const enc = computed(() => (name.value ? encodeURIComponent(name.value) : ''))

/** 当前总览页类型（由路由判断） */
const page = computed<'overview' | 'health' | 'rhythm' | 'leads' | 'piece' | 'settings'>(() => {
  const p = route.path
  if (/\/piece\//.test(p)) return 'piece'
  if (/\/health/.test(p)) return 'health'
  if (/\/rhythm/.test(p)) return 'rhythm'
  if (/\/leads/.test(p)) return 'leads'
  if (/\/settings/.test(p)) return 'settings'
  return 'overview'
})

const overview = ref<BookOverview | null>(null)
const pieces = ref<PieceSummary[]>([])
const leads = ref<LeadsData | null>(null)
const currentPieceNo = computed(() => Number(route.params.no ?? 0))

async function loadOverview(): Promise<void> {
  if (!name.value) return
  try {
    overview.value = await getOverview(name.value)
  } catch {
    overview.value = null
  }
}
async function loadPieces(): Promise<void> {
  if (!name.value) return
  try {
    pieces.value = await listPieces(name.value)
  } catch {
    pieces.value = []
  }
}
async function loadLeads(): Promise<void> {
  if (!name.value) return
  try {
    leads.value = await getLeads(name.value)
  } catch {
    leads.value = null
  }
}

function gotoPiece(no: number): void {
  router.push(`/books/${enc.value}/piece/${no}`)
}

const hintMap: Record<string, string> = {
  health: '体检成本 / 审查 / 文风漂移见中栏图表。',
  rhythm: '字数曲线、钩子与情绪分布见中栏。',
  settings: '境界 / 角色 / 时间线 / 关系图见中栏。',
}

watch(
  page,
  (pg) => {
    if (pg === 'overview') void loadOverview()
    else if (pg === 'piece') void loadPieces()
    else if (pg === 'leads') void loadLeads()
  },
  { immediate: true },
)
</script>

<template>
  <!-- o1 作品概要：关键指标 -->
  <div v-if="page === 'overview' && overview" class="card">
    <div class="card-title">关键指标</div>
    <div class="kv"><span class="k">总字数</span><span class="v">{{ overview.progress.words.toLocaleString() }}</span></div>
    <div class="kv"><span class="k">{{ overview.identity.kind === 'short' ? '篇数' : '章节' }}</span><span class="v">{{ overview.progress.chapters }}</span></div>
    <div class="kv"><span class="k">完成度</span><span class="v cyan">{{ Math.min(Math.round((overview.progress.words / (overview.progress.targetWords || 1)) * 100), 100) }}%</span></div>
    <div class="kv"><span class="k">状态</span><span class="v">{{ overview.state.name }}</span></div>
  </div>

  <!-- a_piece 篇详情：篇列表（可切篇） -->
  <div v-else-if="page === 'piece' && pieces.length" class="card">
    <div class="card-title">篇列表 · 共 {{ pieces.length }} 篇</div>
    <div
      v-for="p in pieces"
      :key="p.篇号"
      class="ledger-item click"
      @click="p.篇号 !== currentPieceNo ? gotoPiece(p.篇号) : undefined"
    >
      <span class="dot" :class="p.篇号 === currentPieceNo ? 'green' : 'gray'"></span>
      <div>
        <b>第{{ p.篇号 }}篇 · {{ p.标题 }}</b>
        <div class="desc">{{ p.目标情绪 ? p.目标情绪 + ' · ' : '' }}{{ p.字数 }} 字</div>
      </div>
    </div>
  </div>

  <!-- a_ledger 账本：条目列表 -->
  <div v-else-if="page === 'leads' && leads && leads.kind === 'long'" class="card">
    <div class="card-title">账本条目 · 全部 <span style="color: var(--text-3)">{{ leads.leads.length }}</span></div>
    <div v-for="l in leads.leads.slice(0, 12)" :key="l.编号" class="ledger-item">
      <span class="dot" :class="l.状态 === '已收尾' ? 'green' : l.状态 === '进行中' ? 'yellow' : 'gray'"></span>
      <div>
        <b>{{ l.类型 }}·{{ l.标题 }}</b>
        <div class="desc">{{ l.状态 }} · 开启第 {{ l.开启章 }} 章</div>
      </div>
    </div>
  </div>

  <!-- health / rhythm / settings：中栏已有图表，右栏给提示 -->
  <div v-else class="card">
    <div class="card-title">{{ ({ health: '体检', rhythm: '节奏', settings: '设定' } as Record<string, string>)[page] || '详情' }}</div>
    <div class="dd-hint">{{ hintMap[page] ?? '数据见中栏。' }}</div>
  </div>
</template>

<style scoped>
/* mockup 覆盖 .card/.card-title/.kv/.ledger-item(.click)；仅补提示文本。 */
.dd-hint{font-size:12px;color:var(--text-2);line-height:1.7}
</style>
