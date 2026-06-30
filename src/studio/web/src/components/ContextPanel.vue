<script setup lang="ts">
// 编辑态右栏：当前文件上下文（对齐 mockup renderEditRight，按文件类型分支照搬结构）。
// 篇文件：getPiece 富数据（本篇/情绪曲线/反转线索/伏笔提醒）；
// 章文件：字数 + 当前章相关账本提醒（getLeads）；scene/pov/hook 等无 API 的 kv 不画（避免空占位）。
import { ref, computed, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { getPiece, getLeads } from '../api/books'
import type { PieceDetailData, LeadsData, Lead } from '../types'

const route = useRoute()
const router = useRouter()
const file = computed(() => (typeof route.query.file === 'string' ? route.query.file : ''))
const bookName = computed(() => (typeof route.params.name === 'string' ? route.params.name : ''))
const enc = computed(() => (bookName.value ? encodeURIComponent(bookName.value) : ''))

/** 文件类型（决定渲染哪套右栏结构） */
const fileType = computed<'piece' | 'chapter' | 'doc'>(() => {
  const p = file.value
  if (!p) return 'doc'
  if (/sp\d/i.test(p) || /篇[\\/]\d/.test(p)) return 'piece'
  if (/ch\d/i.test(p) || /chapters[\\/]/i.test(p)) return 'chapter'
  return 'doc'
})

const pieceNo = computed(() => {
  const m = file.value.match(/sp(\d+)/i) ?? file.value.match(/篇[\\/](\d+)/)
  return m ? Number(m[1]) : 0
})

const piece = ref<PieceDetailData | null>(null)
const words = ref(0)
const loading = ref(false)
const leads = ref<LeadsData | null>(null)

async function loadPiece(): Promise<void> {
  if (!bookName.value || !pieceNo.value) {
    piece.value = null
    return
  }
  try {
    piece.value = await getPiece(bookName.value, pieceNo.value)
  } catch {
    piece.value = null
  }
}

async function loadWords(): Promise<void> {
  if (!file.value || !enc.value) {
    words.value = 0
    return
  }
  loading.value = true
  try {
    const r = await fetch(`/api/books/${enc.value}/file?file=${encodeURIComponent(file.value)}`)
    if (r.ok) {
      const d = (await r.json()) as { content?: string }
      words.value = String(d.content ?? '').replace(/\s+/g, '').length
    } else {
      words.value = 0
    }
  } catch {
    words.value = 0
  } finally {
    loading.value = false
  }
}

async function loadLeads(): Promise<void> {
  if (!bookName.value) {
    leads.value = null
    return
  }
  try {
    leads.value = await getLeads(bookName.value)
  } catch {
    leads.value = null
  }
}

/** 篇：伏笔回收统计 + 情绪曲线 */
const pieceRecv = computed(() =>
  piece.value ? piece.value.list.伏笔回收.filter((e) => !e.未回收).length : 0,
)
const piecePayoffs = computed(() => (piece.value?.list.伏笔回收 ?? []).slice(0, 3))
const pieceEmo = computed(() => piece.value?.list.情绪曲线 ?? [])

/** 章：当前章相关账本提醒（开启章或履历命中当前章；无则取前 3） */
const chapterLeads = computed<Lead[]>(() => {
  if (!leads.value || leads.value.kind !== 'long') return []
  const chNo = Number(file.value.match(/ch(\d+)/i)?.[1] ?? 0)
  const all = leads.value.leads ?? []
  const rel = chNo ? all.filter((l) => l.开启章 === chNo || l.履历?.some((e) => e.章号 === chNo)) : []
  return (rel.length ? rel : all).slice(0, 3)
})

function gotoPiece(): void {
  if (pieceNo.value) router.push(`/books/${enc.value}/piece/${pieceNo.value}`)
}
function gotoLeads(): void {
  router.push(`/books/${enc.value}/leads`)
}

watch(
  [file, bookName],
  () => {
    piece.value = null
    leads.value = null
    if (fileType.value === 'piece') {
      void loadPiece()
    } else {
      void loadWords()
      if (fileType.value === 'chapter') void loadLeads()
    }
  },
  { immediate: true },
)
</script>

<template>
  <!-- 篇文件：本篇 + 情绪曲线 + 反转线索 + 伏笔提醒（数据源 getPiece，全真实） -->
  <template v-if="fileType === 'piece' && piece">
    <div class="card">
      <div class="card-title">
        本篇 <span style="color: var(--ink-cyan)">● {{ piece.meta.字数 > 0 ? '草稿' : '待写' }}</span>
      </div>
      <div class="kv"><span class="k">字数</span><span class="v">{{ piece.meta.字数.toLocaleString() }}</span></div>
      <div class="kv"><span class="k">目标情绪</span><span class="v cyan">{{ piece.meta.目标情绪 || '—' }}</span></div>
      <div class="kv"><span class="k">核心反转</span><span class="v">{{ piece.meta.核心反转 || '—' }}</span></div>
      <div class="kv"><span class="k">伏笔回收</span><span class="v">{{ pieceRecv }}/{{ piece.list.伏笔回收.length }}</span></div>
    </div>

    <div v-if="pieceEmo.length" class="card">
      <div class="card-title">情绪曲线</div>
      <div class="emo-bars">
        <div
          v-for="(e, i) in pieceEmo"
          :key="i"
          class="emo-bar"
          :style="{ height: Math.max(e.强度 * 10, 6) + '%', background: e.强度 >= 8 ? 'var(--cinnabar)' : 'var(--ink-cyan)' }"
          :title="`${e.情绪} ${e.强度}/10`"
        ></div>
      </div>
      <div class="emo-labels"><span v-for="(e, i) in pieceEmo" :key="i">{{ e.情绪.slice(0, 2) }}</span></div>
    </div>

    <div class="card">
      <div class="card-title">反转线索</div>
      <div class="reversal-text">{{ piece.list.反转线索表.核心反转 || '（待补）' }}</div>
      <div class="btn-row">
        <button class="btn primary" style="font-size: 11px; padding: 4px 10px" @click="gotoPiece">看篇详情 →</button>
      </div>
    </div>

    <div v-if="piecePayoffs.length" class="card">
      <div class="card-title">伏笔提醒 <span style="color: var(--text-3)">{{ piecePayoffs.length }}</span></div>
      <div v-for="(e, i) in piecePayoffs" :key="i" class="ledger-item">
        <span class="dot" :class="e.未回收 ? 'red' : 'green'"></span>
        <div>
          <b>{{ e.伏笔 }}</b>
          <div class="desc">{{ e.未回收 ? '未回收' : `回收于 ${e.回收位置}` }}</div>
        </div>
      </div>
    </div>
  </template>

  <!-- 章文件：本章（字数）+ 账本提醒（当前章相关） -->
  <template v-else-if="fileType === 'chapter'">
    <div class="card">
      <div class="card-title">本章 <span style="color: var(--ink-cyan)">● 草稿</span></div>
      <div class="kv"><span class="k">字数</span><span class="v">{{ loading ? '…' : words.toLocaleString() }}</span></div>
      <div class="kv"><span class="k">类型</span><span class="v">正文章</span></div>
    </div>
    <div v-if="chapterLeads.length" class="card">
      <div class="card-title">
        账本提醒 <span style="color: var(--text-3)">{{ chapterLeads.length }}</span>
        <span style="color: var(--ink-cyan); cursor: pointer; text-transform: none; font-weight: 500" @click="gotoLeads">看全部 →</span>
      </div>
      <div v-for="l in chapterLeads" :key="l.编号" class="ledger-item">
        <span class="dot" :class="l.状态 === '已收尾' ? 'green' : l.状态 === '进行中' ? 'yellow' : 'gray'"></span>
        <div>
          <b>{{ l.类型 }}·{{ l.标题 }}</b>
          <div class="desc">{{ l.状态 }} · 开启第 {{ l.开启章 }} 章</div>
        </div>
      </div>
    </div>
  </template>

  <!-- 设定 / 大纲 / 未选：文件信息 -->
  <div v-else class="card">
    <div class="card-title">当前文件</div>
    <div class="kv"><span class="k">文件</span><span class="v cyan" style="word-break: break-all">{{ file || '（未选）' }}</span></div>
    <div class="kv"><span class="k">类型</span><span class="v">{{ file ? '设定 / 大纲' : '—' }}</span></div>
    <div v-if="file" class="kv"><span class="k">字数</span><span class="v">{{ loading ? '…' : words.toLocaleString() }}</span></div>
  </div>
</template>

<style scoped>
/* mockup 覆盖 .card/.card-title/.kv/.ledger-item/.btn-row；仅补情绪曲线柱图容器（mockup 内联，抽类更清晰）。 */
.emo-bars{display:flex;align-items:flex-end;gap:6px;height:50px;margin-bottom:4px}
.emo-bar{flex:1;border-radius:3px 3px 0 0;min-height:4px}
.emo-labels{display:flex;gap:6px;font-size:10px;color:var(--text-3)}
.emo-labels > span{flex:1;text-align:center}
.reversal-text{font-size:12px;color:var(--ink);line-height:1.7}
</style>
