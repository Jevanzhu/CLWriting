<script setup lang="ts">
// 总览右栏（对齐 mockup renderOvRight）：按当前总览页显示对应数据卡。
// o1 关键指标（getOverview）/ piece 篇列表（listPieces）/ leads 账本（getLeads）
// rhythm 各章字数（getRhythm）/ health 关键指标（getHealth）；settings 关系图见中栏。
import { ref, computed, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { getOverview, listPieces, getLeads, getRhythm, getHealth } from '../api/books'
import type { BookOverview, PieceSummary, LeadsData, Rhythm, MetricsReport } from '../types'

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
const rhythm = ref<Rhythm | null>(null)
const health = ref<MetricsReport | null>(null)
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
async function loadRhythm(): Promise<void> {
  if (!name.value) return
  try {
    rhythm.value = await getRhythm(name.value)
  } catch {
    rhythm.value = null
  }
}
async function loadHealth(): Promise<void> {
  if (!name.value) return
  try {
    health.value = (await getHealth(name.value)).metrics
  } catch {
    health.value = null
  }
}

function gotoPiece(no: number): void {
  router.push(`/books/${enc.value}/piece/${no}`)
}

const hintMap: Record<string, string> = {
  settings: '境界 / 角色 / 时间线 / 关系图见中栏。',
}

watch(
  page,
  (pg) => {
    if (pg === 'overview') void loadOverview()
    else if (pg === 'piece') void loadPieces()
    else if (pg === 'leads') void loadLeads()
    else if (pg === 'rhythm') void loadRhythm()
    else if (pg === 'health') void loadHealth()
  },
  { immediate: true },
)
</script>

<template>
  <!-- o1 作品概要：关键指标（对齐 mockup renderOvRight o1 分支） -->
  <!-- mockup o1 右栏：.card>.card-title"关键指标" + kv(总字数/章节/完成度/账本/体检均分/设定) -->
  <!-- 账本/体检均分/设定待 core，占位 —；另补 mockup o4/o5 的"本周字数""分类"占位 kv -->
  <div v-if="page === 'overview' && overview" class="card">
    <div class="card-title">关键指标</div>
    <div class="kv"><span class="k">总字数</span><span class="v">{{ overview.progress.words.toLocaleString() }}</span></div>
    <div class="kv"><span class="k">{{ overview.identity.kind === 'short' ? '篇数' : '章节' }}</span><span class="v">{{ overview.progress.chapters }}</span></div>
    <div class="kv"><span class="k">完成度</span><span class="v cyan">{{ Math.min(Math.round((overview.progress.words / (overview.progress.targetWords || 1)) * 100), 100) }}%</span></div>
    <div class="kv"><span class="k">状态</span><span class="v">{{ overview.state.name }}</span></div>
    <div class="kv"><span class="k">账本</span><span class="v" style="color: var(--text-3)">—</span></div>
    <div class="kv"><span class="k">体检均分</span><span class="v" style="color: var(--text-3)">—</span></div>
    <div class="kv"><span class="k">设定</span><span class="v" style="color: var(--text-3)">—</span></div>
    <!-- mockup o4"本周字数"占位（取近 7 日 timeline，待 core 暴露日维度聚合；先占位） -->
    <div class="kv"><span class="k">本周字数</span><span class="v" style="color: var(--text-3)">—</span></div>
    <!-- mockup o5"分类"占位（账本/章节/体检/大纲 各类计数，待 core） -->
    <div class="kv"><span class="k">分类</span><span class="v" style="color: var(--text-3)">—</span></div>
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

  <!-- a_rhythm：各章字数（真实 wordCurve） -->
  <div v-else-if="page === 'rhythm' && rhythm && rhythm.wordCurve.length" class="card">
    <div class="card-title">各{{ rhythm.kind === 'short' ? '篇' : '章' }}字数</div>
    <div
      v-for="w in rhythm.wordCurve.slice(0, 14)"
      :key="('章号' in w ? w.章号 : w.篇号)"
      class="kv"
    >
      <span class="k">第{{ '章号' in w ? w.章号 : w.篇号 }}{{ rhythm.kind === 'short' ? '篇' : '章' }}</span>
      <span class="v">{{ w.字数.toLocaleString() }}</span>
    </div>
  </div>

  <!-- a_health：问题清单（对齐 mockup renderOvRight a_health 分支） -->
  <!-- mockup：.card>.card-title"问题清单 · 全部" + 逐条 .ledger-item>(.dot.sev + div>(b{章节} + .desc{问题})) -->
  <!-- 真实 health.issues 暂无"问题明细"字段，按 mockup 结构占位（待 core 补 issues 明细） -->
  <div v-else-if="page === 'health'" class="card">
    <div class="card-title">问题清单 · 全部</div>
    <!-- 真实 metrics 概要（保留真实数据，非 mockup 字段但便于参考） -->
    <template v-if="health && health.count > 0">
      <div class="kv"><span class="k">满审率</span><span class="v cyan">{{ Math.round(health.review.fullRate * 100) }}%</span></div>
      <div class="kv"><span class="k">降级率</span><span class="v">{{ Math.round(health.review.downgradeRate * 100) }}%</span></div>
      <div class="kv"><span class="k">平均阻断</span><span class="v">{{ health.review.avgBlockers.toFixed(1) }}</span></div>
      <div class="kv"><span class="k">超上限</span><span class="v">{{ health.cost.overLimitChapters }} {{ health.kind === 'short' ? '篇' : '章' }}</span></div>
      <div class="kv"><span class="k">平均调用</span><span class="v">{{ health.cost.avgCalls.toFixed(1) }}</span></div>
    </template>
    <!-- mockup 问题明细占位：画 .ledger-item 结构（dot.sev + b{章节} + .desc{问题}），数据待 core -->
    <div class="ledger-item">
      <span class="dot yellow"></span>
      <div>
        <b>第<b style="color:var(--text-3)"> — </b>{{ health && health.kind === 'short' ? '篇' : '章' }}</b>
        <div class="desc">问题明细待 core<span style="color:var(--text-3)">（health.issues）</span></div>
      </div>
    </div>
  </div>

  <!-- a_relations / settings：对齐 mockup renderOvRight a_relations 分支 -->
  <!-- mockup：.card"节点">提示文 + .card"全角色">逐条 .kv.click>(.dot + k{名字} + .v.cyan{角色}) -->
  <!-- 关系节点数据待 core（RELATIONS.nodes 无对应 API），按 mockup 结构占位 -->
  <div v-else class="ov-right-group">
    <div class="card">
      <div class="card-title">节点</div>
      <div style="font-size:12px;color:var(--text-2);line-height:1.7">点击图中角色查看详情与关联</div>
      <div style="font-size:11px;color:var(--text-3);margin-top:6px">关系图数据待 core</div>
    </div>
    <div class="card">
      <div class="card-title">全角色</div>
      <!-- 占位节点（mockup .kv.click 结构，dot 内联背景色 + k 名字 + v.cyan 角色） -->
      <div class="kv click">
        <span class="k"><span class="dot" style="display:inline-block;margin-right:6px;background:var(--text-3)"></span><b style="color:var(--text-3)">—</b></span>
        <span class="v cyan" style="color:var(--text-3)">待 core</span>
      </div>
      <div class="kv click">
        <span class="k"><span class="dot" style="display:inline-block;margin-right:6px;background:var(--text-3)"></span><b style="color:var(--text-3)">—</b></span>
        <span class="v cyan" style="color:var(--text-3)">待 core</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* mockup 覆盖 .card/.card-title/.kv/.ledger-item(.click)；本组件无额外样式（提示文走内联）。 */
</style>
