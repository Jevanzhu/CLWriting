<script setup lang="ts">
import { ref, watch, computed } from 'vue'
import { useRoute } from 'vue-router'
import type { Lead, LeadsData } from '../types'
import { getLeads } from '../api/books'

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
    data.value = await getLeads(n)
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
    <div class="panel-pad">
      <div class="panel-title">账本</div>
      <div class="panel-sub">{{ data?.kind === 'long' ? '七类线索 · 推进矩阵 · 停滞预警' : '集子总览 · 各篇反转 / 回收' }}</div>

      <p v-if="loading" class="hint">加载中…</p>
      <p v-else-if="error" class="hint error">加载失败：{{ error }}</p>

      <!-- 长篇 -->
      <template v-else-if="data && data.kind === 'long'">
        <!-- 七类概览 -->
        <div class="card">
          <div class="card-title">七类概览</div>
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
        </div>

        <!-- 停滞预警 -->
        <div v-if="data.stale.length" class="card stale-card">
          <div class="card-title">⚠ 停滞预警<span style="color:var(--text-3);font-weight:normal"> · 进行中 + 距今 ≥3 章</span></div>
          <div v-for="s in data.stale" :key="s.编号" class="ledger-item">
            <span class="clw-dot yellow"></span>
            <div>
              <b>{{ s.编号 }} · {{ s.标题 }}</b>
              <div class="desc">最后推进第 {{ s.最后履历章 }} 章，距今 {{ s.距今 }} 章</div>
            </div>
          </div>
        </div>

        <!-- 账本推进矩阵 -->
        <div class="card">
          <div class="card-title">账本推进矩阵（章 × 线）</div>
          <div class="matrix-scroll">
            <table class="matrix">
              <thead>
                <tr>
                  <th>章</th>
                  <th v-for="l in data.leads" :key="l.编号" :title="`${l.编号} ${l.标题}（${l.类型}）`">{{ l.编号 }}</th>
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
        </div>

        <!-- 线履历 -->
        <div class="card">
          <div class="card-title">线履历</div>
          <div class="lead-grid">
            <div v-for="l in data.leads" :key="l.编号" class="lead-item">
              <div class="lead-head">
                <span class="lead-id">{{ l.编号 }}</span>
                <span class="lead-title">{{ l.标题 }}</span>
                <span class="tag" :class="l.状态 === '已收尾' ? 'green' : l.状态 === '已放弃' ? 'gray' : ''">{{ l.状态 }}</span>
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
        </div>
      </template>

      <!-- 短篇集子 -->
      <template v-else-if="data && data.kind === 'short'">
        <div class="card short-card">
          <div class="card-title">集子总览</div>
          <div class="card-row" style="grid-template-columns:repeat(3,1fr);margin-bottom:12px">
            <div class="stat-card"><div class="n">{{ data.summary.总篇数 }}</div><div class="l">篇数</div></div>
            <div class="stat-card"><div class="n">{{ data.summary.总字数 }}</div><div class="l">总字数</div></div>
            <div class="stat-card"><div class="n">{{ data.summary.平均篇长 }}</div><div class="l">字 / 篇</div></div>
          </div>
          <p class="short-hint">短篇无跨篇账本。各篇清单（核心反转 / 情绪峰值 / 伏笔回收）一览，点「详情」进单篇。</p>
        </div>
        <div v-if="data.pieces.length" class="card">
          <div class="card-title">各篇清单</div>
          <table class="col-table">
            <thead>
              <tr><th>篇</th><th>标题</th><th>目标情绪</th><th>情绪峰值</th><th>回收率</th><th>核心反转</th><th></th></tr>
            </thead>
            <tbody>
              <tr v-for="p in data.pieces" :key="p.篇号">
                <td>{{ p.篇号 }}</td>
                <td class="col-title">{{ p.标题 }}<span class="col-words">（{{ p.字数 }} 字）</span></td>
                <td>{{ p.目标情绪 ?? '—' }}</td>
                <td>
                  <span v-if="p.情绪峰值 !== undefined" :class="{ peak: p.情绪峰值 >= 8 }">{{ p.情绪峰值 }}/10 {{ p.情绪类型 }}</span>
                  <span v-else>—</span>
                </td>
                <td>
                  <span v-if="p.回收率" :class="{ unresolved: p.未回收数 }">{{ p.回收率 }}<template v-if="p.未回收数">（{{ p.未回收数 }} 弃）</template></span>
                  <span v-else>—</span>
                </td>
                <td class="col-rev">{{ p.核心反转 ?? '—' }}</td>
                <td><RouterLink class="col-go" :to="`/books/${encodeURIComponent(name)}/piece/${p.篇号}`">详情 →</RouterLink></td>
              </tr>
            </tbody>
          </table>
        </div>
        <p v-else class="hint">（暂无定稿篇，先在工作台写一篇）</p>
      </template>
    </div>
  </section>
</template>

<style scoped>
.leads-page {
  margin: 0 auto;
}
.stale-card {
  border-color: var(--ochre);
}
.overview {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}
.overview th,
.overview td {
  padding: 7px 10px;
  border-bottom: 1px solid var(--border);
  text-align: center;
}
.overview th {
  color: var(--text-2);
  font-weight: 600;
  font-size: 12px;
}
.overview td:first-child {
  text-align: left;
}
.overview tr.empty {
  color: var(--border-2);
}
.matrix-scroll {
  overflow-x: auto;
}
.matrix {
  border-collapse: collapse;
  font-size: 12px;
}
.matrix th,
.matrix td {
  padding: 5px 9px;
  border: 1px solid var(--border);
  text-align: center;
  white-space: nowrap;
}
.matrix th {
  color: var(--text-2);
  font-weight: 600;
  font-size: 11px;
}
.matrix .ch-no {
  font-weight: 600;
  color: var(--ink);
  background: var(--paper);
}
.matrix td.filled {
  background: var(--active-bg);
  color: var(--ink-cyan);
  font-weight: 600;
}
.lead-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
  gap: 12px;
}
.lead-item {
  padding: 12px 14px;
  background: var(--paper);
  border-radius: 8px;
}
.lead-head {
  display: flex;
  gap: 8px;
  align-items: baseline;
  margin-bottom: 6px;
  flex-wrap: wrap;
}
.lead-id {
  font-family: ui-monospace, monospace;
  font-size: 11px;
  color: var(--text-3);
}
.lead-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--ink);
}
.lead-head .tag {
  margin-left: auto;
}
.specialty {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-bottom: 8px;
}
.specialty span {
  padding: 1px 8px;
  background: var(--warn-bg);
  color: var(--ochre);
  border-radius: 10px;
  font-size: 11px;
}
.history {
  margin: 6px 0 0;
  padding-left: 0;
  list-style: none;
  display: grid;
  gap: 4px;
}
.history li {
  display: grid;
  grid-template-columns: 56px 44px 1fr;
  gap: 6px;
  font-size: 12px;
  align-items: baseline;
}
.hist-ch {
  color: var(--text-3);
}
.hist-verb {
  color: var(--ink-cyan);
  font-weight: 600;
}
.hist-evid {
  color: var(--text-2);
}
.short-card {
  background: var(--active-bg);
  border-color: var(--active-bg);
}
.short-hint {
  margin: 8px 0 0;
  font-size: 12px;
  color: var(--ink-cyan);
  line-height: 1.6;
}
.col-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
}
.col-table th,
.col-table td {
  padding: 7px 10px;
  border-bottom: 1px solid var(--border);
  text-align: left;
  vertical-align: top;
}
.col-table th {
  color: var(--text-2);
  font-weight: 600;
  font-size: 11px;
}
.col-title {
  font-weight: 600;
  color: var(--ink);
}
.col-words {
  color: var(--text-3);
  font-weight: normal;
  font-size: 11px;
}
.col-rev {
  color: var(--text-2);
  max-width: 220px;
}
.peak {
  color: var(--cinnabar);
  font-weight: 600;
}
.unresolved {
  color: var(--cinnabar);
}
.col-go {
  color: var(--ink-cyan);
  text-decoration: none;
  white-space: nowrap;
}
.col-go:hover {
  text-decoration: underline;
}
.hint {
  color: var(--text-2);
  padding-top: 24px;
}
.hint.error {
  color: var(--cinnabar);
}
</style>
