<script setup lang="ts">
import { ref, watch, computed } from 'vue'
import { useRoute } from 'vue-router'
import BookTabs from '../components/BookTabs.vue'

interface LeadEntry {
  章号: number
  动词: string
  证据: string
  回填?: boolean
}
interface Lead {
  编号: string
  标题: string
  类型: string
  状态: string
  开启章: number
  履历: LeadEntry[]
  境界体系?: string
  当前境界?: string
  父局线?: string
  欠方?: string
  债主?: string
}
interface Overview {
  类型: string
  total: number
  进行中: number
  已收尾: number
  已放弃: number
}
interface Stale {
  编号: string
  类型: string
  标题: string
  开启章: number
  最后履历章: number
  距今: number
}
interface LeadsData {
  kind: 'long'
  overview: Overview[]
  leads: Lead[]
  matrix: { 章号: number; 编号: string; 类型: string; 标题: string; 动词: string; 证据: string }[]
  currentChapter: number
  stale: Stale[]
}

const route = useRoute()
const name = computed(() => (typeof route.params.name === 'string' ? route.params.name : ''))
const data = ref<LeadsData | null>(null)
const loading = ref(true)
const error = ref('')

async function load(n: string): Promise<void> {
  loading.value = true
  error.value = ''
  data.value = null
  try {
    const r = await fetch(`/api/books/${encodeURIComponent(n)}/leads`)
    if (!r.ok) {
      const e = (await r.json().catch(() => ({}))) as { error?: string }
      throw new Error(e.error ?? `HTTP ${r.status}`)
    }
    data.value = (await r.json()) as LeadsData
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

/** 矩阵 cell 查询:章号-编号 → {动词, 证据} */
const cellMap = computed(() => {
  const m = new Map<string, { 动词: string; 证据: string }>()
  const d = data.value
  if (d && d.kind === 'long') {
    for (const x of d.matrix) m.set(`${x.章号}-${x.编号}`, { 动词: x.动词, 证据: x.证据 })
  }
  return m
})

function cellVerb(ch: number, id: string): string {
  return cellMap.value.get(`${ch}-${id}`)?.动词 ?? ''
}
function cellTitle(ch: number, id: string): string {
  const c = cellMap.value.get(`${ch}-${id}`)
  return c ? `${c.动词}：${c.证据}` : ''
}

function statusClass(s: string): string {
  return s === '进行中' ? 'st-doing' : s === '已收尾' ? 'st-done' : 'st-drop'
}

/** 特化字段(成长线境界/局线父线/关系债欠方债主) */
function specialties(l: Lead): string[] {
  const out: string[] = []
  if (l.境界体系) out.push(`境界:${l.当前境界 ?? '—'} / ${l.境界体系}`)
  if (l.父局线) out.push(`父局线:${l.父局线}`)
  if (l.欠方 || l.债主) out.push(`${l.欠方 ?? '—'} 欠 ${l.债主 ?? '—'}`)
  return out
}
</script>

<template>
  <section class="leads-page">
    <BookTabs :name="name" active="leads" />

    <p v-if="loading" class="hint">加载中…</p>
    <p v-else-if="error" class="hint error">加载失败:{{ error }}</p>
    <template v-else-if="data && data.kind === 'long'">
      <!-- 七类概览 -->
      <article class="card">
        <h3 class="block-title">七类概览</h3>
        <table class="overview">
          <thead>
            <tr><th>类型</th><th>总数</th><th>进行中</th><th>已收尾</th><th>已放弃</th></tr>
          </thead>
          <tbody>
            <tr v-for="o in data.overview" :key="o.类型" :class="{ empty: o.total === 0 }">
              <td>{{ o.类型 }}</td>
              <td>{{ o.total }}</td>
              <td>{{ o.进行中 }}</td>
              <td>{{ o.已收尾 }}</td>
              <td>{{ o.已放弃 }}</td>
            </tr>
          </tbody>
        </table>
      </article>

      <!-- 停滞预警 -->
      <article v-if="data.stale.length" class="card stale-card">
        <h3 class="block-title">⚠ 停滞预警(进行中 + 距今 ≥3 章)</h3>
        <ul class="stale-list">
          <li v-for="s in data.stale" :key="s.编号">
            <span class="lead-id">{{ s.编号 }}</span>
            <span class="lead-title">{{ s.标题 }}</span>
            <span class="stale-gap">最后推进第 {{ s.最后履历章 }} 章,距今 {{ s.距今 }} 章</span>
          </li>
        </ul>
      </article>

      <!-- 账本推进矩阵 -->
      <article class="card">
        <h3 class="block-title">账本推进矩阵(章 × 线)</h3>
        <div class="matrix-scroll">
          <table class="matrix">
            <thead>
              <tr>
                <th>章</th>
                <th v-for="l in data.leads" :key="l.编号" :title="`${l.编号} ${l.标题}(${l.类型})`">{{ l.编号 }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="ch in data.currentChapter" :key="ch">
                <td class="ch-no">{{ ch }}</td>
                <td
                  v-for="l in data.leads"
                  :key="l.编号"
                  :class="{ filled: cellVerb(ch, l.编号) }"
                  :title="cellTitle(ch, l.编号)"
                >{{ cellVerb(ch, l.编号) }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </article>

      <!-- 线履历 -->
      <article class="card">
        <h3 class="block-title">线履历</h3>
        <div class="lead-grid">
          <div v-for="l in data.leads" :key="l.编号" class="lead-item">
            <div class="lead-head">
              <span class="lead-id">{{ l.编号 }}</span>
              <span class="lead-title">{{ l.标题 }}</span>
              <span class="status" :class="statusClass(l.状态)">{{ l.状态 }}</span>
            </div>
            <div v-if="specialties(l).length" class="specialty">
              <span v-for="(s, i) in specialties(l)" :key="i">{{ s }}</span>
            </div>
            <ol class="history">
              <li v-for="(e, i) in l.履历" :key="i">
                <span class="hist-ch">第{{ e.章号 }}章</span>
                <span class="hist-verb">{{ e.动词 }}</span>
                <span class="hist-evid">{{ e.证据 }}</span>
              </li>
            </ol>
          </div>
        </div>
      </article>
    </template>
  </section>
</template>

<style scoped>
.leads-page {
  max-width: 1040px;
  margin: 0 auto;
}
.card {
  background: #fff;
  border: 1px solid #e5e7eb;
  border-radius: 8px;
  padding: 16px 20px;
}
.card + .card {
  margin-top: 16px;
}
.block-title {
  margin: 0 0 12px;
  font-size: 13px;
  font-weight: 600;
  color: #6b7280;
  letter-spacing: 0.04em;
}
.hint {
  color: #6b7280;
}
.hint.error {
  color: #dc2626;
}

/* 概览表 */
.overview {
  width: 100%;
  border-collapse: collapse;
  font-size: 14px;
}
.overview th,
.overview td {
  padding: 7px 10px;
  border-bottom: 1px solid #f3f4f6;
  text-align: center;
}
.overview th {
  color: #6b7280;
  font-weight: 600;
  font-size: 13px;
}
.overview td:first-child {
  text-align: left;
}
.overview tr.empty {
  color: #d1d5db;
}

/* 停滞 */
.stale-card {
  border-color: #fcd34d;
  background: #fffbeb;
}
.stale-list {
  margin: 0;
  padding: 0;
  list-style: none;
  display: grid;
  gap: 8px;
}
.stale-list li {
  display: flex;
  gap: 10px;
  align-items: baseline;
  font-size: 14px;
}
.stale-gap {
  color: #b45309;
  font-size: 13px;
}

/* 矩阵 */
.matrix-scroll {
  overflow-x: auto;
}
.matrix {
  border-collapse: collapse;
  font-size: 13px;
}
.matrix th,
.matrix td {
  padding: 6px 10px;
  border: 1px solid #f3f4f6;
  text-align: center;
  white-space: nowrap;
}
.matrix th {
  color: #6b7280;
  font-weight: 600;
  font-size: 12px;
}
.matrix .ch-no {
  font-weight: 600;
  color: #374151;
  background: #f9fafb;
}
.matrix td.filled {
  background: #dbeafe;
  color: #1e40af;
  font-weight: 600;
}

/* 线履历 */
.lead-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
  gap: 12px;
}
.lead-item {
  padding: 12px;
  background: #f9fafb;
  border-radius: 6px;
}
.lead-head {
  display: flex;
  gap: 8px;
  align-items: baseline;
  margin-bottom: 6px;
}
.lead-id {
  font-family: ui-monospace, monospace;
  font-size: 12px;
  color: #6b7280;
}
.lead-title {
  font-size: 14px;
  font-weight: 600;
  color: #111827;
}
.status {
  margin-left: auto;
  padding: 1px 8px;
  border-radius: 10px;
  font-size: 12px;
}
.status.st-doing {
  background: #dbeafe;
  color: #1e40af;
}
.status.st-done {
  background: #d1fae5;
  color: #065f46;
}
.status.st-drop {
  background: #f3f4f6;
  color: #6b7280;
}
.specialty {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-bottom: 8px;
}
.specialty span {
  padding: 1px 8px;
  background: #fef3c7;
  color: #92400e;
  border-radius: 10px;
  font-size: 12px;
}
.history {
  margin: 0;
  padding-left: 0;
  list-style: none;
  display: grid;
  gap: 4px;
}
.history li {
  display: grid;
  grid-template-columns: 56px 44px 1fr;
  gap: 6px;
  font-size: 13px;
  align-items: baseline;
}
.hist-ch {
  color: #6b7280;
}
.hist-verb {
  color: #3b82f6;
  font-weight: 600;
}
.hist-evid {
  color: #4b5563;
}
</style>
