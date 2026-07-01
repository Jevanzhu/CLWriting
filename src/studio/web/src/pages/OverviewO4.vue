<script setup lang="ts">
// o4 写作日历（总览子页面）：近 14 日字数热力格 + 动笔天数 + 14 日总字数 + 日均。
// 数据 getOverview（timeline {date,count}[]）。热力纯 CSS（color-mix 映射深浅）。
import { ref, watch, computed } from 'vue'
import { useRoute } from 'vue-router'
import ErrorState from '../components/ErrorState.vue'
import type { BookOverview } from '../types'
import { getOverview } from '../api/books'

const route = useRoute()
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

/** 近 14 日（末 14 条） */
const recent = computed(() => (data.value?.timeline ?? []).slice(-14))
const maxCount = computed(() => Math.max(...recent.value.map((t) => t.count), 1))
const activeDays = computed(() => recent.value.filter((t) => t.count > 0).length)
const totalWords = computed(() => recent.value.reduce((s, t) => s + t.count, 0))
const dailyAvg = computed(() => (activeDays.value ? Math.round(totalWords.value / activeDays.value) : 0))

/** 热力格底色：count 映射 ink-cyan 深浅（0 → border 灰） */
function heatStyle(count: number): string {
  if (count <= 0) return 'background:var(--border)'
  const ratio = Math.min(count / maxCount.value, 1)
  const pct = Math.max(Math.round(ratio * 100), 18) // 最低 18% 可见
  return `background:color-mix(in srgb,var(--ink-cyan) ${pct}%,var(--border))`
}

function fmtWords(n: number): string {
  return n < 10000 ? `${n}` : `${(n / 10000).toFixed(1)} 万`
}

const rangeLabel = computed(() => {
  const r = recent.value
  if (r.length === 0) return ''
  return `${r[0].date.slice(5)} ~ ${r[r.length - 1].date.slice(5)}`
})
</script>

<template>
  <section class="ov-page">
    <div class="bento-wrap">
      <div class="bento-head">
        <h1 class="bento-title">写作日历</h1>
        <div class="bento-sub">
          <span class="meta-chip">近 14 日热力</span>
          <span v-if="rangeLabel" class="meta-chip">{{ rangeLabel }}</span>
        </div>
      </div>
      <p v-if="loading" class="hint">加载中…</p>
      <ErrorState v-else-if="error" :msg="error" @retry="load(name)" />
      <div v-else-if="data" class="bento-grid">
        <div class="bento-card bento-full">
          <div class="bc-label">近 14 日字数热力</div>
          <div class="heat-row">
            <div
              v-for="(t, i) in recent"
              :key="i"
              class="heat-cell"
              :style="heatStyle(t.count)"
              :title="`${t.date} · ${t.count} 字`"
            >
              <span>{{ t.count > 0 ? t.count : '' }}</span>
            </div>
          </div>
          <div class="heat-labels">
            <span v-for="(t, i) in recent" :key="i">{{ t.date.slice(5) }}</span>
          </div>
        </div>
        <div class="bento-card">
          <div class="bc-menu">⋮</div>
          <div class="bc-label">动笔天数</div>
          <div class="bc-stat">{{ activeDays }}<span class="bc-unit"> / 14</span></div>
        </div>
        <div class="bento-card">
          <div class="bc-menu">⋮</div>
          <div class="bc-label">14 日总字数</div>
          <div class="bc-stat">{{ fmtWords(totalWords) }}</div>
        </div>
        <div class="bento-card">
          <div class="bc-menu">⋮</div>
          <div class="bc-label">日均（动笔日）</div>
          <div class="bc-stat">{{ dailyAvg }}</div>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.ov-page {
  margin: 0 auto;
}
.ov-page .hint {
  color: var(--text-2);
  padding-top: 24px;
}
.ov-page .heat-row {
  display: flex;
  gap: 6px;
  padding: 14px 8px 4px;
}
.ov-page .heat-cell {
  flex: 1;
  height: 44px;
  border-radius: 6px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 11px;
  color: var(--text-2);
  transition: transform 0.15s;
}
.ov-page .heat-cell:hover {
  transform: scale(1.08);
}
.ov-page .heat-labels {
  display: flex;
  gap: 6px;
  padding: 4px 8px 0;
}
.ov-page .heat-labels span {
  flex: 1;
  text-align: center;
  font-size: 10px;
  color: var(--text-3);
}
.ov-page .bc-unit {
  font-size: 13px;
  color: var(--text-3);
  font-weight: normal;
}
</style>
