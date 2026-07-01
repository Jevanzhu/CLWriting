<script setup lang="ts">
// o3 完成度（总览子页面）：综合完成度环 + 五维度进度（正文真实，余四维度占位待 core 聚合）。
// 数据 getOverview（progress.percent/targetWords/words）。
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

/** 完成度%（正文维度，按字数/targetWords） */
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

/** 五维度：正文真实，余占位（待 core 聚合） */
const dims = computed<{ name: string; pct: number | null; label: string }[]>(() => [
  { name: '正文', pct: pct.value, label: `${pct.value}%` },
  { name: '大纲', pct: null, label: '—' },
  { name: '设定', pct: null, label: '—' },
  { name: '体检', pct: null, label: '—' },
  { name: '账本', pct: null, label: '—' },
])
</script>

<template>
  <section class="ov-page">
    <div class="bento-wrap">
      <div class="bento-head">
        <h1 class="bento-title">完成度</h1>
        <div class="bento-sub">
          <span class="meta-chip">五维度综合</span>
          <span class="meta-chip">正文 · 大纲 · 设定 · 体检 · 账本</span>
        </div>
      </div>
      <p v-if="loading" class="hint">加载中…</p>
      <ErrorState v-else-if="error" :msg="error" @retry="load(name)" />
      <div v-else-if="data" class="bento-grid">
        <div class="bento-card bento-lg">
          <div class="bc-label">综合完成度（按正文）</div>
          <div class="bc-ring" :style="ringStyle">
            <span>{{ pct }}<span>%</span></span>
          </div>
          <div class="bc-foot">正文维度真实，大纲/设定/体检/账本待 core 聚合</div>
        </div>
        <div class="bento-card bento-full">
          <div class="bc-label">各维度进度</div>
          <div class="dim-list">
            <div v-for="d in dims" :key="d.name" class="dim">
              <span>{{ d.name }}</span>
              <div class="dim-bar">
                <div :style="{ width: (d.pct ?? 0) + '%' }"></div>
              </div>
              <b>{{ d.label }}</b>
            </div>
          </div>
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
.ov-page .dim-list {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 12px 4px;
}
.ov-page .dim {
  display: flex;
  align-items: center;
  gap: 12px;
  font-size: 13px;
  color: var(--text-2);
}
.ov-page .dim span {
  width: 48px;
  flex-shrink: 0;
}
.ov-page .dim b {
  margin-left: auto;
  color: var(--ink);
}
.ov-page .dim-bar {
  flex: 1;
  height: 6px;
  background: var(--border);
  border-radius: 3px;
  overflow: hidden;
}
.ov-page .dim-bar > div {
  height: 100%;
  background: var(--ink-cyan);
  transition: width 0.4s;
}
</style>
