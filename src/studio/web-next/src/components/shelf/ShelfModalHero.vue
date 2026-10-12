<script setup lang="ts">
/**
 * 书架弹层「继续写作」hero 卡（自 ShelfModal.vue 拆出，纯搬家）。
 * 弹层专属横版单行卡（grid 视图，进度右置）；紧凑单行（list 视图）与全屏页同构，
 * 收敛为共享子件 ShelfHeroList。
 * 全屏页竖版在 ShelfHeroCard；三档的契约与「打开」手势单源在 shelf-hero——
 * role/tabindex/keydown 键盘可达与点击是同一手势，语义不变。
 */
import { ArrowRight } from 'lucide-vue-next'
import { formatWords, formatRelative, progressPercent } from '../../composables/useShelf'
import ShelfHeroList from './ShelfHeroList.vue'
import { useShelfHeroGesture, type ShelfHeroEmits, type ShelfHeroProps } from './shelf-hero'
// hero 族共享声明（非 scoped 全局表，按模块注入一次；收纳口径见该文件头注）
import './hero-shared.css'

const props = defineProps<ShelfHeroProps>()

const emit = defineEmits<ShelfHeroEmits>()

const { onActivate, onMove } = useShelfHeroGesture(() => props.book.name, (name) => emit('open', name))
</script>

<template>
  <section
    v-if="viewMode === 'grid'"
    class="hero-card"
    role="button"
    tabindex="0"
    @mousemove="onMove"
    @click="onActivate"
    @keydown.enter.prevent="onActivate"
    @keydown.space.prevent="onActivate"
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
  <!-- list 单行：与全屏页同构，共享子件渲染-->
  <ShelfHeroList v-else :book="book" variant="modal" @open="emit('open', $event)" />
</template>

<style scoped>
/* hero 跨整宽——继续写作快捷入口 + 字数进度可视化。
   外壳定位/描边/渐变底、光斑骨架与 hover 描边、标签/箭标/进度条/卡脚共有声明
   已收 hero-shared.css（本块只留弹层横版档差异） */
.hero-card {
  grid-column: 1 / -1;
  display: flex;
  align-items: center;
  gap: var(--size-4-4);
  padding: var(--size-4-3) var(--size-4-4);
  border-radius: var(--radius-m);
  box-shadow: var(--shadow-s);
}
/* 光斑半径按本档卡高收小（全屏页竖版 600px，见 ShelfHeroCard） */
.hero-card::before {
  background: radial-gradient(
    400px circle at var(--mx, 30%) var(--my, 50%),
    color-mix(in srgb, var(--text-accent) 10%, transparent),
    transparent 50%
  );
}
.hero-card:hover {
  transform: translateY(-1px);
}
.hero-left {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
}
.hero-label {
  letter-spacing: 0.06em;
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
.progress-text {
  font-size: var(--font-size-xxs);
  color: var(--text-faint);
  font-variant-numeric: tabular-nums;
}
.hero-foot {
  flex-direction: column;
  align-items: flex-end;
  gap: 2px;
  font-size: var(--font-size-xs);
  flex-shrink: 0;
}
.hero-time {
  color: var(--text-faint);
}
/* 列表模式 hero（hero-list 族）已随抽取搬入 ShelfHeroList.vue
 * （modal 档变体，原值不变）。 */
</style>
