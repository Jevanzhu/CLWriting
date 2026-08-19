<script setup lang="ts">
/**
 * 书架页「继续写作」hero 卡（hh §八-16 自 pages/Shelf.vue 拆出，纯搬家）。
 * 全屏页专属竖版大卡（grid 视图）+ 紧凑单行（list 视图）——弹层横版在 ShelfModalHero。
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
    @mousemove="onCardMove"
    @click="emit('open', book.name)"
  >
    <div class="hero-top">
      <span class="hero-label">继续写作</span>
      <ArrowRight :size="18" class="hero-arrow" />
    </div>
    <h2 class="hero-title">{{ book.title ?? book.name }}</h2>
    <p v-if="book.latestChapter" class="hero-recent">
      最近 · {{ book.latestChapter }}
    </p>
    <div v-if="book.targetWords" class="hero-progress">
      <div class="progress-bar">
        <div class="progress-fill" :style="{ width: progressPercent(book) + '%' }" />
      </div>
      <span class="progress-text">
        {{ formatWords(book.words) }} / {{ formatWords(book.targetWords) }}
      </span>
    </div>
    <div class="hero-foot">
      <span>{{ book.chapters ?? 0 }} 章</span>
      <span v-if="book.lastEdited" class="hero-time"
        ><span class="dot">·</span>{{ formatRelative(book.lastEdited) }}</span
      >
    </div>
  </section>
  <section
    v-else
    class="hero-list"
    @mousemove="onCardMove"
    @click="emit('open', book.name)"
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
/* 继续写作 hero 卡：横跨整宽，最近编辑书的快捷入口 + 字数进度可视化 */
.hero-card {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: var(--size-4-2);
  padding: var(--size-4-6);
  margin-bottom: var(--size-4-10);
  border-radius: var(--radius-l);
  background: linear-gradient(135deg, var(--background-secondary-alt), var(--background-secondary));
  border: 1px solid var(--background-modifier-border);
  box-shadow: var(--shadow-m);
  cursor: pointer;
  overflow: hidden;
  transition: transform var(--dur-norm) var(--ease-out), box-shadow var(--dur-norm) var(--ease-out), border-color var(--dur-norm) var(--ease-out);
}
.hero-card::before {
  content: '';
  position: absolute;
  inset: 0;
  border-radius: inherit;
  background: radial-gradient(600px circle at var(--mx, 30%) var(--my, 30%), color-mix(in srgb, var(--text-accent) 10%, transparent), transparent 50%);
  opacity: 0;
  transition: opacity var(--dur-norm) var(--ease-out);
  pointer-events: none;
}
.hero-card:hover::before {
  opacity: 1;
}
.hero-card:hover {
  transform: translateY(-2px);
  border-color: color-mix(in srgb, var(--text-accent) 40%, var(--background-modifier-border));
  box-shadow: var(--shadow-l);
}
.hero-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.hero-label {
  font-size: var(--font-size-xs);
  color: var(--text-accent);
  font-weight: 500;
  letter-spacing: 0.08em;
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
.hero-title {
  margin: 0;
  font-size: var(--font-size-2xl);
  font-weight: 700;
  letter-spacing: -0.025em;
  line-height: 1.2;
  color: var(--text-normal);
}
.hero-recent {
  margin: 0;
  font-size: var(--font-size-m);
  color: var(--text-muted);
}
.hero-progress {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-top: var(--size-4-2);
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
  font-size: var(--font-size-xs);
  color: var(--text-faint);
  font-variant-numeric: tabular-nums;
}
.hero-foot {
  display: flex;
  align-items: center;
  gap: var(--size-4-2);
  margin-top: var(--size-4-2);
  font-size: var(--font-size-s);
  color: var(--text-muted);
  font-variant-numeric: tabular-nums;
}
.hero-foot .dot {
  color: var(--text-faint);
}

/* 列表模式的 hero：紧凑单行，匹配列表风格（无大渐变/进度条）*/
.hero-list {
  position: relative;
  display: flex;
  align-items: center;
  gap: var(--size-4-3);
  padding: var(--size-4-3) var(--size-4-4);
  margin-bottom: var(--size-4-6);
  border-radius: var(--radius-m);
  border: 1px solid var(--background-modifier-border);
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
  background: radial-gradient(400px circle at var(--mx, 30%) var(--my, 50%), color-mix(in srgb, var(--text-accent) 8%, transparent), transparent 50%);
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
  font-size: var(--font-size-s);
  color: var(--text-faint);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.hero-list-meta {
  display: flex;
  align-items: center;
  gap: var(--size-4-3);
  margin-left: auto;
  font-size: var(--font-size-s);
  color: var(--text-muted);
  font-variant-numeric: tabular-nums;
  flex-shrink: 0;
}
.hero-list-arrow {
  color: var(--text-accent);
  flex-shrink: 0;
}

@media (prefers-reduced-motion: reduce) {
  .hero-card:hover {
    transform: none;
  }
  .hero-arrow {
    opacity: 1;
    transform: none;
    transition: none;
  }
}
</style>
