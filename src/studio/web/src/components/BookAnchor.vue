<script setup lang="ts">
// 左栏顶段：书名锚点 + 进度条（三态共用）。GET /overview 取 genre/words/targetWords/percent。
import { ref, computed, watch } from 'vue'
import { getOverview } from '../api/books'
import type { BookOverview } from '../types'

const props = defineProps<{ bookName?: string }>()
const ov = ref<BookOverview | null>(null)

/** 字数万化（≥1万显示 x.x万） */
function wn(w: number): string {
  return w >= 10000 ? (w / 10000).toFixed(1) + '万' : String(w)
}

/** 进度%：优先后端 percent，否则按 words/targetWords 算，封顶 100 */
const pct = computed(() => {
  if (!ov.value) return 0
  const p = ov.value.progress
  if (typeof p.percent === 'number') return Math.min(p.percent, 100)
  if (p.targetWords && p.targetWords > 0) return Math.min(Math.round((p.words / p.targetWords) * 100), 100)
  return 0
})

async function load(): Promise<void> {
  if (!props.bookName) return
  try {
    ov.value = await getOverview(props.bookName)
  } catch {
    ov.value = null
  }
}
watch(() => props.bookName, () => load(), { immediate: true })
</script>

<template>
  <div v-if="ov" class="book-anchor">
    <div class="ba-name">{{ bookName }}</div>
    <div class="ba-meta">{{ ov.identity.genre || '未分类' }} · {{ wn(ov.progress.words) }}字 · {{ pct }}%</div>
    <div class="ba-bar"><div :style="{ width: pct + '%' }"></div></div>
  </div>
</template>

<style scoped>
.book-anchor{padding:12px 12px 10px;border-bottom:1px solid var(--white-14);flex-shrink:0}
.ba-name{font-size:15px;font-weight:700;color:var(--ink);letter-spacing:.5px;line-height:1.2}
.ba-meta{font-size:11px;color:var(--text-3);margin-top:4px}
.ba-bar{height:3px;background:var(--white-14);border-radius:2px;margin-top:8px;overflow:hidden}
.ba-bar>div{height:100%;background:var(--ink-cyan);border-radius:2px;transition:width .3s}
</style>
