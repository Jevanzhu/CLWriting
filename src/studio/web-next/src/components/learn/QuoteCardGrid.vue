<script setup lang="ts">
/**
 * 文风收割 · 金句候选区（hh §八-16 自 LearnView.vue 拆出，纯搬家）。
 * 网格卡片点击即勾选（候选制红线：品味归人）——勾选态直接读写 learn store。
 */
import { Check } from 'lucide-vue-next'
import { useLearnStore } from '../../stores/learn'

const learn = useLearnStore()
</script>

<template>
  <section v-if="learn.quotes.length" class="sec">
    <h2 class="sec-title">金句候选 <span class="sec-count">{{ learn.quotes.length }}</span></h2>
    <div class="quote-grid">
      <div
        v-for="q in learn.quotes"
        :key="q.正文"
        class="quote-card"
        :class="{ picked: learn.isQuotePicked(q.正文) }"
        @click="learn.toggleQuote(q.正文)"
      >
        <p class="quote-text">{{ q.正文 }}</p>
        <div class="quote-foot">
          <span class="src">{{ q.出处 }} · {{ q.场景 }}</span>
          <Check v-if="learn.isQuotePicked(q.正文)" :size="13" class="picked-mark" />
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
/* 区段基础（与 LearnView 同式） */
.sec {
  margin-bottom: var(--size-4-6);
}
.sec-title {
  display: flex;
  align-items: center;
  gap: var(--size-4-2);
  margin: 0 0 var(--size-4-3);
  font-size: var(--font-size-l);
  font-weight: 700;
  color: var(--text-muted);
}
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
  /* 内存核查（2026-08-25 M-P3-15）：金句正文默认 4 行截断（纯样式，store 数据
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
.src {
  font-size: var(--font-size-xs);
  color: var(--text-faint);
}
.picked-mark {
  color: var(--text-accent);
}
</style>
