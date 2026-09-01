<script setup lang="ts">
/**
 * 书架弹层「继续写作」hero 卡（hh §八-16 自 ShelfModal.vue 拆出，纯搬家）。
 * 弹层专属横版单行卡（grid 视图，进度右置）+ 紧凑单行（list 视图）——全屏页竖版在 ShelfHeroCard。
 * R36-23（三十六轮）：role/tabindex/keydown 补键盘可达（原仅 @click，R72-12 只修了
 * ShelfHeroCard 漏此）；Enter/Space 与点击同一手势处理，语义不变。
 */
import { ArrowRight } from 'lucide-vue-next'
import type { BookEntry } from '../../api/shelf'
import { formatWords, formatRelative, progressPercent, onCardMove } from '../../composables/useShelf'

defineProps<{
  book: BookEntry
  viewMode: 'grid' | 'list'
}>()

const emit = defineEmits<{
  open: [name: string]
}>()
</script>

<template>
  <section
    v-if="viewMode === 'grid'"
    class="hero-card"
    role="button"
    tabindex="0"
    @mousemove="onCardMove"
    @click="emit('open', book.name)"
    @keydown.enter.prevent="emit('open', book.name)"
    @keydown.space.prevent="emit('open', book.name)"
  >
    <div class="hero-left">
      <span class="hero-label">继续写作</span>
      <ArrowRight :size="15" class="hero-arrow" />
    </div>
    <div class="hero-mid">
      <h3 class="hero-title">{{ book.title ?? book.name }}</h3>
      <p v-if="book.latestChapter" class="hero-recent">最近 · {{ book.latestChapter }}</p>
    </div>
    <div v-if="book.targetWords" class="hero-prog">
      <div class="progress-bar">
        <div class="progress-fill" :style="{ width: progressPercent(book) + '%' }" />
      </div>
      <span class="progress-text">{{ formatWords(book.words) }} / {{ formatWords(book.targetWords) }}</span>
    </div>
    <div class="hero-foot">
      <span>{{ book.chapters ?? 0 }} 章</span>
      <span v-if="book.lastEdited" class="hero-time">{{ formatRelative(book.lastEdited) }}</span>
    </div>
  </section>
  <section
    v-else
    class="hero-list"
    role="button"
    tabindex="0"
    @mousemove="onCardMove"
    @click="emit('open', book.name)"
    @keydown.enter.prevent="emit('open', book.name)"
    @keydown.space.prevent="emit('open', book.name)"
  >
    <span class="hero-list-label">继续写作</span>
    <span class="hero-list-name">{{ book.title ?? book.name }}</span>
    <span v-if="book.latestChapter" class="hero-list-recent">最近 · {{ book.latestChapter }}</span>
    <span class="hero-list-meta">
      <span>{{ book.chapters ?? 0 }} 章</span>
      <span v-if="book.lastEdited">{{ formatRelative(book.lastEdited) }}</span>
    </span>
    <ArrowRight :size="15" class="hero-list-arrow" />
  </section>
</template>

<style scoped>
/* hero 跨整宽——继续写作快捷入口 + 字数进度可视化 */
.hero-card {
  grid-column: 1 / -1;
  position: relative;
  display: flex;
  align-items: center;
  gap: var(--size-4-4);
  padding: var(--size-4-3) var(--size-4-4);
  border-radius: var(--radius-m);
  background: linear-gradient(135deg, var(--background-secondary-alt), var(--background-secondary));
  border: 1px solid var(--background-modifier-border);
  box-shadow: var(--shadow-s);
  cursor: pointer;
  overflow: hidden;
  transition: transform var(--dur-norm) var(--ease-out), box-shadow var(--dur-norm) var(--ease-out), border-color var(--dur-norm) var(--ease-out);
}
.hero-card::before {
  content: '';
  position: absolute;
  inset: 0;
  border-radius: inherit;
  background: radial-gradient(400px circle at var(--mx, 30%) var(--my, 50%), color-mix(in srgb, var(--text-accent) 10%, transparent), transparent 50%);
  opacity: 0;
  transition: opacity var(--dur-norm) var(--ease-out);
  pointer-events: none;
}
.hero-card:hover::before {
  opacity: 1;
}
.hero-card:hover {
  transform: translateY(-1px);
  border-color: color-mix(in srgb, var(--text-accent) 40%, var(--background-modifier-border));
  box-shadow: var(--shadow-l);
}
.hero-left {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
}
.hero-label {
  font-size: var(--font-size-xs);
  color: var(--text-accent);
  font-weight: 500;
  letter-spacing: 0.06em;
}
.hero-arrow {
  color: var(--text-accent);
  opacity: 0;
  transform: translateX(-4px);
  transition: opacity var(--dur-norm) var(--ease-out), transform var(--dur-norm) var(--ease-out);
}
.hero-card:hover .hero-arrow {
  opacity: 1;
  transform: translateX(0);
}
.hero-mid {
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-width: 0;
  flex: 1;
}
.hero-title {
  margin: 0;
  font-size: var(--font-size-xl);
  font-weight: 600;
  letter-spacing: -0.015em;
  color: var(--text-normal);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.hero-recent {
  margin: 0;
  font-size: var(--font-size-xs);
  color: var(--text-faint);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.hero-prog {
  display: flex;
  flex-direction: column;
  gap: 4px;
  width: 180px;
  flex-shrink: 0;
}
.progress-bar {
  height: 4px;
  border-radius: var(--radius-s);
  background: var(--background-modifier-hover);
  overflow: hidden;
}
.progress-fill {
  height: 100%;
  border-radius: var(--radius-s);
  background: var(--text-accent);
  transition: width var(--dur-slow) var(--ease-out);
}
.progress-text {
  font-size: var(--font-size-xxs);
  color: var(--text-faint);
  font-variant-numeric: tabular-nums;
}
.hero-foot {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 2px;
  font-size: var(--font-size-xs);
  color: var(--text-muted);
  font-variant-numeric: tabular-nums;
  flex-shrink: 0;
}
.hero-time {
  color: var(--text-faint);
}
/* 列表模式 hero：紧凑单行 */
.hero-list {
  grid-column: 1 / -1;
  position: relative;
  display: flex;
  align-items: center;
  gap: var(--size-4-3);
  padding: var(--size-4-2) var(--size-4-3);
  border-radius: var(--radius-m);
  border: 1px solid var(--background-modifier-border);
  background: var(--background-secondary);
  cursor: pointer;
  text-align: left;
  color: var(--text-normal);
  overflow: hidden;
  transition: border-color var(--dur-fast) var(--ease-out);
}
.hero-list::before {
  content: '';
  position: absolute;
  inset: 0;
  border-radius: inherit;
  background: radial-gradient(300px circle at var(--mx, 30%) var(--my, 50%), color-mix(in srgb, var(--text-accent) 8%, transparent), transparent 50%);
  opacity: 0;
  transition: opacity var(--dur-norm) var(--ease-out);
  pointer-events: none;
}
.hero-list:hover::before {
  opacity: 1;
}
.hero-list:hover {
  border-color: color-mix(in srgb, var(--text-accent) 30%, var(--background-modifier-border));
}
.hero-list-label {
  font-size: var(--font-size-xs);
  color: var(--text-accent);
  font-weight: 500;
  letter-spacing: 0.06em;
  flex-shrink: 0;
}
.hero-list-name {
  font-size: var(--font-size-m);
  font-weight: 600;
  color: var(--text-normal);
  white-space: nowrap;
}
.hero-list-recent {
  font-size: var(--font-size-xs);
  color: var(--text-faint);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.hero-list-meta {
  display: flex;
  align-items: center;
  gap: var(--size-4-2);
  margin-left: auto;
  font-size: var(--font-size-xs);
  color: var(--text-muted);
  font-variant-numeric: tabular-nums;
  flex-shrink: 0;
}
.hero-list-arrow {
  color: var(--text-accent);
  flex-shrink: 0;
}
</style>
