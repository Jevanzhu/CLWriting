<script setup lang="ts">
/**
 * 书架「继续写作」hero 紧凑单行（list 视图）——R0912-C2-P3-5（2026-09-12 独立重评
 * 修复批）：ShelfHeroCard（全屏页）与 ShelfModalHero（弹层）的 hero-list 段模板逐字
 * 同构，收敛为共享子组件（纯结构去重，DOM/类名/事件语义不变；role/tabindex/keydown
 * 键盘可达性 R72-12/R36-23 契约随迁）。
 * 两处差异面（全屏页 vs 弹层 grid 容器内）经 variant prop 传：
 * 弹层档 = grid 跨全列 + 次底色 + 紧 padding + 300px 光斑 + 注释级字号；全屏页档反之。
 */
import { ArrowRight } from 'lucide-vue-next'
import type { BookEntry } from '../../api/shelf'
import { formatRelative, onCardMove } from '../../composables/useShelf'

defineProps<{
  book: BookEntry
  /** 全屏页（page）/ 弹层（modal）两档差异（定位与字号档） */
  variant: 'page' | 'modal'
}>()

const emit = defineEmits<{
  open: [name: string]
}>()
</script>

<template>
  <section
    class="hero-list"
    :class="variant === 'modal' ? 'hero-list--modal' : 'hero-list--page'"
    role="button"
    tabindex="0"
    @keydown.enter.prevent="emit('open', book.name)"
    @keydown.space.prevent="emit('open', book.name)"
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
/* 列表模式 hero：紧凑单行（公共骨架自两处原样收拢；档位差异见 --page/--modal 修饰块） */
.hero-list {
  position: relative;
  display: flex;
  align-items: center;
  gap: var(--size-4-3);
  border-radius: var(--radius-m);
  border: 1px solid var(--background-modifier-border);
  cursor: pointer;
  text-align: left;
  color: var(--text-normal);
  overflow: hidden;
  transition: border-color var(--dur-fast) var(--ease-out);
}
/* 全屏页档：非 grid 容器，占位/间距独立 */
.hero-list--page {
  padding: var(--size-4-3) var(--size-4-4);
  margin-bottom: var(--size-4-6);
}
/* 弹层档：在 modal grid 中跨全列 + 次底色 + 更紧 padding（原值不变） */
.hero-list--modal {
  grid-column: 1 / -1;
  padding: var(--size-4-2) var(--size-4-3);
  background: var(--background-secondary);
}
/* 跟随光标光斑：骨架公共，仅半径两档（page 400 / modal 300） */
.hero-list::before {
  content: '';
  position: absolute;
  inset: 0;
  border-radius: inherit;
  opacity: 0;
  transition: opacity var(--dur-norm) var(--ease-out);
  pointer-events: none;
}
.hero-list--page::before {
  background: radial-gradient(400px circle at var(--mx, 30%) var(--my, 50%), color-mix(in srgb, var(--text-accent) 8%, transparent), transparent 50%);
}
.hero-list--modal::before {
  background: radial-gradient(300px circle at var(--mx, 30%) var(--my, 50%), color-mix(in srgb, var(--text-accent) 8%, transparent), transparent 50%);
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
/* 最近章节：全屏页 s 档 / 弹层 xs 档 */
.hero-list-recent {
  font-size: var(--font-size-s);
  color: var(--text-faint);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.hero-list--modal .hero-list-recent {
  font-size: var(--font-size-xs);
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
/* 弹层档 meta 更紧更小（原值不变） */
.hero-list--modal .hero-list-meta {
  gap: var(--size-4-2);
  font-size: var(--font-size-xs);
}
.hero-list-arrow {
  color: var(--text-accent);
  flex-shrink: 0;
}
</style>
