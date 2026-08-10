/**
 * 书卡组件：grid（卡片）/ list（表格行）双模式。
 * 尺寸差异通过 CSS 变量参数化——全屏页设大值，浮层用紧凑默认值。
 *
 * 变量覆盖点（外壳 :deep 或祖先设值）：
 * --shelf-card-pad / --shelf-card-radius / --shelf-card-min-h
 * --shelf-list-cols
 */
<script setup lang="ts">
import { ArrowRight, CheckCircle2, Circle } from 'lucide-vue-next'
import { formatWords, formatRelative } from '../../composables/useShelf'
import type { BookEntry } from '../../api/shelf'

defineProps<{
  book: BookEntry
  variant: 'grid' | 'list'
  /** grid 模式入场动画延迟（序号 × 40ms）；不传则无延迟 */
  index?: number
  /** 批量管理模式：显示 checkbox，click 切换选中而非打开 */
  batchMode?: boolean
  /** 批量模式下是否选中 */
  selected?: boolean
}>()

defineEmits<{
  click: [name: string]
  move: [e: MouseEvent]
  contextmenu: [e: MouseEvent]
}>()
</script>

<template>
  <!-- grid 卡片：Linear 风渐变 + hover 鼠标跟随柔光晕 + 进入箭头 -->
  <button
    v-if="variant === 'grid'"
    class="book-card"
    :class="{ batch: batchMode, selected }"
    :style="index !== undefined ? { animationDelay: (index * 40) + 'ms' } : undefined"
    @mousemove="$emit('move', $event)"
    @click="$emit('click', book.name)"
    @contextmenu.prevent="$emit('contextmenu', $event)"
  >
    <!-- 批量模式 checkmark（左上角） -->
    <CheckCircle2 v-if="batchMode && selected" :size="20" class="batch-check active" />
    <Circle v-else-if="batchMode" :size="20" class="batch-check" />
    <h3 class="book-title">{{ book.title ?? book.name }}</h3>
    <ArrowRight v-if="!batchMode" :size="15" class="card-arrow" />
    <div class="card-foot">
      <div class="card-stats">
        <span>{{ book.chapters ?? 0 }} 章</span>
        <span>{{ formatWords(book.words) }}</span>
      </div>
      <span v-if="book.lastEdited" class="book-time">{{ formatRelative(book.lastEdited) }}</span>
    </div>
  </button>

  <!-- list 行：表格化 grid 列对齐 + hover 高亮 -->
  <button
    v-else
    class="list-row"
    :class="{ batch: batchMode, selected }"
    @mousemove="$emit('move', $event)"
    @click="$emit('click', book.name)"
    @contextmenu.prevent="$emit('contextmenu', $event)"
  >
    <CheckCircle2 v-if="batchMode && selected" :size="16" class="batch-check-sm active" />
    <Circle v-else-if="batchMode" :size="16" class="batch-check-sm" />
    <div class="col-name">
      <span class="list-name">{{ book.title ?? book.name }}</span>
      <span v-if="book.latestChapter" class="list-recent">{{ book.latestChapter }}</span>
    </div>
    <span class="col-num">{{ book.chapters ?? 0 }} 章</span>
    <span class="col-num">{{ formatWords(book.words) }}</span>
    <span class="col-edited">{{ book.lastEdited ? formatRelative(book.lastEdited) : '—' }}</span>
    <ArrowRight v-if="!batchMode" :size="15" class="list-arrow" />
  </button>
</template>

<style scoped>
/* ── 批量模式 ── */
.batch-check {
  position: absolute;
  top: var(--shelf-card-pad, var(--size-4-3));
  left: var(--shelf-card-pad, var(--size-4-3));
  z-index: 1;
  color: var(--text-faint);
  transition: color var(--dur-fast) var(--ease-out);
}
.batch-check.active {
  color: var(--text-accent);
}
.batch-check-sm {
  flex-shrink: 0;
  color: var(--text-faint);
}
.batch-check-sm.active {
  color: var(--text-accent);
}
/* 批量模式下卡片/行选中态：accent 边框 */
.book-card.selected,
.list-row.selected {
  border-color: var(--text-accent);
  box-shadow: 0 0 0 1px var(--text-accent), var(--shadow-s);
}
/* 批量模式下标题右移避让 checkmark */
.book-card.batch .book-title {
  padding-left: 28px;
}
.list-row.batch .col-name {
  padding-left: 2px;
}

/* ── grid 卡片 ── */
.book-card {
  position: relative;
  display: flex;
  flex-direction: column;
  padding: var(--shelf-card-pad, var(--size-4-3));
  border-radius: var(--shelf-card-radius, var(--radius-m));
  background: linear-gradient(180deg, var(--background-secondary-alt), var(--background-secondary));
  border: 1px solid var(--background-modifier-border);
  box-shadow: var(--shadow-s);
  min-height: var(--shelf-card-min-h, 96px);
  cursor: pointer;
  text-align: left;
  color: var(--text-normal);
  overflow: hidden;
  animation: var(--shelf-card-anim, none);
  transition: transform var(--dur-norm) var(--ease-out), box-shadow var(--dur-norm) var(--ease-out), border-color var(--dur-norm) var(--ease-out);
}
/* Linear 招牌 glow：hover 时鼠标位置发出 accent 色柔和光晕 */
.book-card::before {
  content: '';
  position: absolute;
  inset: 0;
  border-radius: inherit;
  background: radial-gradient(420px circle at var(--mx, 50%) var(--my, 50%), color-mix(in srgb, var(--text-accent) 14%, transparent), transparent 45%);
  opacity: 0;
  transition: opacity var(--dur-norm) var(--ease-out);
  pointer-events: none;
}
.book-card:hover::before {
  opacity: 1;
}
.book-card:hover {
  transform: translateY(-2px);
  border-color: color-mix(in srgb, var(--text-accent) 40%, var(--background-modifier-border));
  box-shadow: var(--shadow-l);
}
/* 进入箭头：绝对定位右上角，hover 显形平移 */
.card-arrow {
  position: absolute;
  top: var(--shelf-card-pad, var(--size-4-3));
  right: var(--shelf-card-pad, var(--size-4-3));
  color: var(--text-accent);
  opacity: 0;
  transform: translateX(-4px);
  transition: opacity var(--dur-norm) var(--ease-out), transform var(--dur-norm) var(--ease-out);
}
.book-card:hover .card-arrow {
  opacity: 1;
  transform: translateX(0);
}
/* 书名：卡片视觉主体，紧字距 + 单行省略；右留白避让箭头 */
.book-title {
  margin: 0;
  padding-right: var(--size-4-4);
  font-size: var(--shelf-title-fs, var(--font-size-m));
  font-weight: 600;
  letter-spacing: -0.015em;
  line-height: 1.3;
  color: var(--text-normal);
  display: -webkit-box;
  -webkit-line-clamp: var(--shelf-card-line-clamp, 2);
  -webkit-box-orient: vertical;
  overflow: hidden;
}
/* 卡片底部：细分隔线 + 数据 + 时间。margin-top auto 推到底部 */
.card-foot {
  margin-top: auto;
  padding-top: var(--size-4-2);
  border-top: 1px solid var(--background-modifier-border);
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.card-stats {
  display: flex;
  justify-content: space-between;
  font-size: var(--font-size-xs);
  color: var(--text-muted);
  font-variant-numeric: tabular-nums;
}
.book-time {
  font-size: var(--font-size-xxs);
  color: var(--text-faint);
}

/* ── list 行 ── */
.list-row {
  position: relative;
  display: grid;
  grid-template-columns: var(--shelf-list-cols, 1fr 56px 72px 72px 18px);
  align-items: center;
  gap: var(--size-4-2);
  padding: var(--size-4-2) var(--size-4-2);
  background: transparent;
  border: none;
  border-bottom: 1px solid var(--background-modifier-border);
  cursor: pointer;
  text-align: left;
  color: var(--text-normal);
  overflow: hidden;
  transition: background var(--dur-fast) var(--ease-out);
}
.list-row:last-child {
  border-bottom: none;
}
.list-row::before {
  content: '';
  position: absolute;
  inset: 0;
  border-radius: inherit;
  background: radial-gradient(300px circle at var(--mx, 50%) var(--my, 50%), color-mix(in srgb, var(--text-accent) 8%, transparent), transparent 50%);
  opacity: 0;
  transition: opacity var(--dur-norm) var(--ease-out);
  pointer-events: none;
}
.list-row:hover::before {
  opacity: 1;
}
.list-row:hover .list-name {
  color: var(--text-accent);
}
/* 名称列：书名（主）+ 最近章节（副）上下排 */
.col-name {
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-width: 0;
}
.list-name {
  font-size: var(--font-size-s);
  font-weight: 500;
  color: var(--text-normal);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.list-recent {
  font-size: var(--font-size-xxs);
  color: var(--text-faint);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
/* 数字列右对齐 + tabular */
.col-num {
  font-size: var(--font-size-xs);
  color: var(--text-muted);
  font-variant-numeric: tabular-nums;
  text-align: right;
  white-space: nowrap;
}
.col-edited {
  font-size: var(--font-size-xs);
  color: var(--text-faint);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.list-arrow {
  color: var(--text-faint);
  opacity: 0;
  transition: opacity var(--dur-fast) var(--ease-out);
}
.list-row:hover .list-arrow {
  opacity: 1;
  color: var(--text-accent);
}

@media (prefers-reduced-motion: reduce) {
  .book-card:hover {
    transform: none;
  }
  .card-arrow {
    opacity: 1;
    transform: none;
    transition: none;
  }
  .list-arrow {
    opacity: 1;
    transition: none;
  }
}
</style>
