<script setup lang="ts">
/**
 * 书架页「继续写作」hero 卡（自 pages/Shelf.vue 拆出，纯搬家）。
 * 全屏页专属竖版大卡（grid 视图）；紧凑单行（list 视图）与弹层同构，
 * 收敛为共享子件 ShelfHeroList。
 * 弹层横版大卡在 ShelfModalHero；三档的契约与「打开」手势单源在 shelf-hero。
 */
import { ArrowRight } from 'lucide-vue-next'
import { formatWords, formatRelative, progressPercent } from '../../composables/useShelf'
import ShelfHeroList from './ShelfHeroList.vue'
import { useShelfHeroGesture, type ShelfHeroEmits, type ShelfHeroProps } from './shelf-hero'
// hero 族共享声明（非 scoped 全局表，按模块注入一次；收纳口径见该文件头注）
import './hero-shared.css'

const props = defineProps<ShelfHeroProps>()

const emit = defineEmits<ShelfHeroEmits>()

const { onActivate, onMove } = useShelfHeroGesture(
  () => props.book.name,
  (name) => emit('open', name),
)
</script>

<template>
  <!-- role/tabindex/keydown 补键盘与读屏可达性（原仅 @click） -->
  <section
    v-if="viewMode === 'grid'"
    class="hero-card"
    role="button"
    tabindex="0"
    @keydown.enter.prevent="onActivate"
    @keydown.space.prevent="onActivate"
    @mousemove="onMove"
    @click="onActivate"
  >
    <div class="hero-top">
      <span class="hero-label">继续写作</span>
      <ArrowRight :size="18" class="hero-arrow" />
    </div>
    <h2 class="hero-title">{{ book.title ?? book.name }}</h2>
    <p v-if="book.latestChapter" class="hero-recent">最近 · {{ book.latestChapter }}</p>
    <div v-if="book.targetWords" class="hero-progress">
      <div class="progress-bar">
        <div class="progress-fill" :style="{ width: progressPercent(book) + '%' }" />
      </div>
      <span class="progress-text"> {{ formatWords(book.words) }} / {{ formatWords(book.targetWords) }} </span>
    </div>
    <div class="hero-foot">
      <span>{{ book.chapters ?? 0 }} 章</span>
      <span v-if="book.lastEdited" class="hero-time"
        ><span class="dot">·</span>{{ formatRelative(book.lastEdited) }}</span
      >
    </div>
  </section>
  <!-- list 单行：与弹层同构，共享子件渲染-->
  <ShelfHeroList v-else :book="book" variant="page" @open="emit('open', $event)" />
</template>

<style scoped>
/* 继续写作 hero 卡：横跨整宽，最近编辑书的快捷入口 + 字数进度可视化。
   外壳定位/描边/渐变底、光斑骨架与 hover 描边、标签/箭标/进度条/卡脚共有声明
   已收 hero-shared.css（本块只留竖版档差异） */
.hero-card {
  display: flex;
  flex-direction: column;
  gap: var(--size-4-2);
  padding: var(--size-4-6);
  margin-bottom: var(--size-4-10);
  border-radius: var(--radius-l);
  box-shadow: var(--shadow-m);
}
/* 光斑半径按本档卡高加大（弹层横版 400px，见 ShelfModalHero） */
.hero-card::before {
  background: radial-gradient(
    600px circle at var(--mx, 30%) var(--my, 30%),
    color-mix(in srgb, var(--text-accent) 10%, transparent),
    transparent 50%
  );
}
.hero-card:hover {
  transform: translateY(-2px);
}
.hero-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.hero-label {
  letter-spacing: 0.08em;
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
.progress-text {
  font-size: var(--font-size-xs);
  color: var(--text-faint);
  font-variant-numeric: tabular-nums;
}
.hero-foot {
  align-items: center;
  gap: var(--size-4-2);
  margin-top: var(--size-4-2);
  font-size: var(--font-size-s);
}
.hero-foot .dot {
  color: var(--text-faint);
}

/* 列表模式 hero（hero-list 族）已随抽取搬入 ShelfHeroList.vue
 * （page 档变体，原值不变）。 */

@media (prefers-reduced-motion: reduce) {
  .hero-card:hover {
    transform: none;
  }
  /* 选择器带 .hero-card 前缀——否则与 hero-shared.css 的同名类规则等特异性平局，
     结果随两份样式表插入顺序摆动（共享表只出 hover 前态，此处须恒胜） */
  .hero-card .hero-arrow {
    opacity: 1;
    transform: none;
    transition: none;
  }
}
</style>
