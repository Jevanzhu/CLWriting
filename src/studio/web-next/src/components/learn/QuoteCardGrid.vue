<script setup lang="ts">
/**
 * 文风收割 · 金句候选区（自 LearnView.vue 拆出，纯搬家）。
 * 网格卡片点击即勾选（候选制红线：品味归人）——勾选态直接读写 learn store。
 * 区段骨架与文字按钮的共有声明走 learn-shared.css（与样章候选区共）。
 */
import { computed, ref, watch } from 'vue'
import { Check } from 'lucide-vue-next'
import { useLearnStore } from '../../stores/learn'
import { capView, RENDER_CAP } from '../../shared/render-cap'
// 候选区共享声明（非 scoped 全局表，按模块注入一次；收纳口径见该文件头注）
import './learn-shared.css'

const learn = useLearnStore()

// ── 金句区渲染上限（帽值与 capView 均取自 shared/render-cap 单源）──
// 金句量不受前端控制，整区 v-for 全量渲染时 DOM 随量线性爆炸；默认渲染前 RENDER_CAP
// 张，超出「显示剩余 N 条」按需展开（计数/勾选仍面向全量 learn.quotes，仅渲染面截断）。
const expanded = ref(false)
const visibleQuotes = computed(() => {
  if (expanded.value || learn.quotes.length <= RENDER_CAP) return learn.quotes
  return capView(learn.quotes, RENDER_CAP).view
})
// 展开态跨收割重置（#23 同款）：收割跑完（loading 落 false）即清，
// 新一轮数据回到 100 张上限；commit 后列表收缩不推 loading，展开态保留
watch(
  () => learn.loading,
  (v, old) => {
    if (old && !v) expanded.value = false
  },
)
</script>

<template>
  <section v-if="learn.quotes.length" class="sec">
    <h2 class="sec-title">
      金句候选 <span class="sec-count">{{ learn.quotes.length }}</span>
    </h2>
    <div class="quote-grid">
      <!-- 勾选卡片补键盘可达性（原仅 @click，键盘不可达）
：key 与勾选身份改 出处+正文（同文不同出处此前 duplicate key
           + 勾选联动）——身份计算在 learn store（quoteKey），模板传整对象 -->
      <div
        v-for="q in visibleQuotes"
        :key="`${q.出处}\u0000${q.正文}`"
        class="quote-card"
        :class="{ picked: learn.isQuotePicked(q) }"
        role="button"
        tabindex="0"
        @keydown.enter.prevent="learn.toggleQuote(q)"
        @keydown.space.prevent="learn.toggleQuote(q)"
        @click="learn.toggleQuote(q)"
      >
        <p class="quote-text">{{ q.正文 }}</p>
        <div class="quote-foot">
          <span class="src">{{ q.出处 }} · {{ q.场景 }}</span>
          <Check v-if="learn.isQuotePicked(q)" :size="13" class="picked-mark" />
        </div>
      </div>
    </div>
    <!-- 渲染上限的展开钮（计数/勾选仍面向全量 learn.quotes） -->
    <button
      v-if="learn.quotes.length > RENDER_CAP && !expanded"
      class="text-btn expand-more"
      @click="expanded = true"
    >
      显示剩余 {{ learn.quotes.length - RENDER_CAP }} 条
    </button>
  </section>
</template>

<style scoped>
/* 区段基础（.sec/.sec-title）与 .text-btn 已收 learn-shared.css（本块只留本区独有） */
.sec-count {
  font-size: var(--font-size-xs);
  font-weight: 500;
  color: var(--text-muted);
  background: var(--background-modifier-hover);
  padding: 1px 7px;
  border-radius: 8px;
}

/* 金句网格 */
.quote-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: var(--size-4-2);
}
.quote-card {
  border-left: 3px solid var(--background-modifier-border-active);
  border-radius: 0 var(--radius-m) var(--radius-m) 0;
  background: var(--background-secondary);
  padding: var(--size-4-3);
  cursor: pointer;
  transition: all var(--dur-fast) var(--ease-out);
}
.quote-card:hover {
  background: var(--background-modifier-hover);
}
.quote-card.picked {
  border-left-color: var(--interactive-accent);
  background: var(--background-modifier-active-hover);
}
.quote-text {
  margin: 0 0 var(--size-4-2);
  font-size: var(--font-size-m);
  line-height: 1.7;
  color: var(--text-normal);
  font-family: var(--prose-font);
  /* 内存核查：金句正文默认 4 行截断（纯样式，store 数据
     形态不动；超长候选正文全量渲染会撑爆网格卡片） */
  display: -webkit-box;
  -webkit-line-clamp: 4;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.quote-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
/* 展开钮用 .text-btn（样式单源在 learn-shared.css） */
.picked-mark {
  color: var(--text-accent);
}
</style>
