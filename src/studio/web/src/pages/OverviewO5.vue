<script setup lang="ts">
// o5 近期动态（总览子页面）：用 overview.timeline 衍生"近期写作动态"——
// 近 7 日字数条形 + 连续写作天数 + 本周动笔 + 本周字数。
// 注：mockup o5 是"事件流 + 本周分类计数"，事件流聚合 API 待 core；现以 timeline 衍生写作动态占位。
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

/** 近 7 日字数条形 */
const week = computed(() => (data.value?.timeline ?? []).slice(-7))
const weekMax = computed(() => Math.max(...week.value.map((t) => t.count), 1))
const weekBars = computed(() =>
  week.value.map((t) => ({
    date: t.date.slice(5),
    count: t.count,
    h: Math.max((t.count / weekMax.value) * 100, t.count > 0 ? 8 : 3),
  })),
)
const weekActive = computed(() => week.value.filter((t) => t.count > 0).length)
const weekTotal = computed(() => week.value.reduce((s, t) => s + t.count, 0))

/** 连续写作天数（从 timeline 末尾往前数 count>0，截至最近写作日） */
const streak = computed(() => {
  const tl = data.value?.timeline ?? []
  let s = 0
  for (let i = tl.length - 1; i >= 0; i--) {
    if (tl[i].count > 0) s++
    else break
  }
  return s
})

function fmtWords(n: number): string {
  return n < 10000 ? `${n}` : `${(n / 10000).toFixed(1)} 万`
}
</script>

<template>
  <section class="ov-page">
    <div class="bento-wrap">
      <div class="bento-head">
        <h1 class="bento-title">近期动态</h1>
        <div class="bento-sub">
          <span class="meta-chip">写作动态</span>
          <span class="meta-chip">事件流版待 core</span>
        </div>
      </div>
      <p v-if="loading" class="hint">加载中…</p>
      <ErrorState v-else-if="error" :msg="error" @retry="load(name)" />
      <div v-else-if="data" class="bento-grid">
        <!-- 近 7 日字数条形 -->
        <div v-if="weekBars.length" class="bento-card bento-full">
          <div class="bc-label">近 {{ weekBars.length }} 日字数</div>
          <div class="bc-bars" style="height: 120px">
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
        <div class="bento-card">
          <div class="bc-menu">⋮</div>
          <div class="bc-label">连续写作</div>
          <div class="bc-stat">{{ streak }}<span class="bc-unit"> 天</span></div>
        </div>
        <div class="bento-card">
          <div class="bc-menu">⋮</div>
          <div class="bc-label">本周动笔</div>
          <div class="bc-stat">{{ weekActive }}<span class="bc-unit"> / 7</span></div>
        </div>
        <div class="bento-card">
          <div class="bc-menu">⋮</div>
          <div class="bc-label">本周字数</div>
          <div class="bc-stat">{{ fmtWords(weekTotal) }}</div>
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
.ov-page .bc-unit {
  font-size: 13px;
  color: var(--text-3);
  font-weight: normal;
}
</style>
