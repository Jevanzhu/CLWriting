<script setup lang="ts">
// 文风收割视图（M12 后置）：扫定稿正文产样章/金句候选 → 作者勾选 → 入库 文风/样章库。
// learn 规则打分（借 #10 机检）**不涉大模型**——始终可用，无 AI 可达性置灰
//（区别于三审/改写/分析三兄弟）。候选制红线：勾选才入库，品味归人。
import { computed } from 'vue'
import { GraduationCap, Sparkles, PackageCheck, AlertCircle } from 'lucide-vue-next'
import { useLearnStore } from '../stores/learn'
import { useTreeStore } from '../stores/tree'

const props = defineProps<{ bookName: string }>()
const learn = useLearnStore()
const tree = useTreeStore()

// 定稿正文章节数（引导提示用）
const chapterCount = computed(
  () => [...tree.byDocId.values()].filter((n) => n.path.startsWith('定稿/正文/')).length,
)

function scoreClass(score: number): string {
  if (score >= 90) return 'score-a'
  if (score >= 75) return 'score-b'
  return 'score-c'
}

async function onHarvest(): Promise<void> {
  await learn.harvest(props.bookName)
}
async function onCommit(): Promise<void> {
  await learn.commit(props.bookName)
}
</script>

<template>
  <div class="learn-scroll">
    <header class="learn-head">
      <div class="learn-title-row">
        <GraduationCap :size="18" />
        <h1 class="learn-title">文风收割</h1>
      </div>
      <p class="learn-lede">
        扫描定稿正文，按 #10 机检打分 + 场景预归类，产出样章/金句候选。
        作者勾选后才入库到 <code>文风/样章库</code>——品味归人，不自动入库。
      </p>
      <div class="learn-actions">
        <button class="btn primary" :disabled="learn.loading" @click="onHarvest">
          <Sparkles :size="14" :class="{ spin: learn.loading }" />
          <span>{{ learn.loading ? '收割中…' : '收割候选' }}</span>
        </button>
        <button
          class="btn"
          :disabled="!learn.hasResult || learn.pickedCount === 0 || learn.committing"
          @click="onCommit"
        >
          <PackageCheck :size="14" />
          <span>{{ learn.committing ? '入库中…' : `入库勾选（${learn.pickedCount}）` }}</span>
        </button>
        <span v-if="learn.hasResult" class="learn-stat">
          样章 {{ learn.samples.length }} · 金句 {{ learn.quotes.length }}
        </span>
      </div>
    </header>

    <div v-if="learn.error" class="learn-err">
      <AlertCircle :size="14" />
      <span>{{ learn.error }}</span>
    </div>

    <div v-if="learn.commitMessage" class="learn-msg">{{ learn.commitMessage }}</div>

    <div
      v-if="!learn.hasResult && !learn.loading && !learn.error"
      class="learn-placeholder"
    >
      <GraduationCap :size="40" />
      <p v-if="chapterCount > 0">点击「收割候选」扫描 {{ chapterCount }} 章定稿正文。</p>
      <p v-else>当前没有定稿正文可收割——先写正文并定稿。</p>
    </div>

    <div v-if="learn.hasResult" class="learn-content">
      <!-- 样章候选 -->
      <section v-if="learn.samples.length" class="cand-section">
        <h2 class="cand-section-title">
          样章候选<span class="cand-count">{{ learn.samples.length }}</span>
        </h2>
        <p class="cand-section-hint">段落分块（50-500 字）+ #10 打分 ≥60，每场景取 top 5。</p>
        <div class="cand-list">
          <div
            v-for="(s, i) in learn.samples"
            :key="i"
            class="cand-card"
            :class="{ picked: learn.isSamplePicked(s.正文) }"
          >
            <div class="cand-card-head">
              <span class="scene-tag">{{ s.场景 }}</span>
              <span class="score" :class="scoreClass(s.打分)">{{ s.打分 }}</span>
              <span class="src">{{ s.出处 }}</span>
              <input
                type="checkbox"
                :checked="learn.isSamplePicked(s.正文)"
                @change="learn.toggleSample(s.正文)"
              />
            </div>
            <p class="cand-body">{{ s.正文 }}</p>
          </div>
        </div>
      </section>

      <!-- 金句候选 -->
      <section v-if="learn.quotes.length" class="cand-section">
        <h2 class="cand-section-title">
          金句候选<span class="cand-count">{{ learn.quotes.length }}</span>
        </h2>
        <p class="cand-section-hint">短句（10-50 字）含钩子/情绪/对比特征，每场景取 top 3。</p>
        <div class="quote-list">
          <div
            v-for="(q, i) in learn.quotes"
            :key="i"
            class="quote-card"
            :class="{ picked: learn.isQuotePicked(q.正文) }"
          >
            <input
              type="checkbox"
              :checked="learn.isQuotePicked(q.正文)"
              @change="learn.toggleQuote(q.正文)"
            />
            <div class="quote-body">
              <span class="quote-text">{{ q.正文 }}</span>
              <span class="src">{{ q.出处 }} · {{ q.场景 }}</span>
            </div>
          </div>
        </div>
      </section>

      <div
        v-if="!learn.samples.length && !learn.quotes.length"
        class="learn-placeholder"
      >
        <p>本轮无合格候选——定稿正文打分普遍偏低或无特征短句。</p>
      </div>
    </div>
  </div>
</template>

<style scoped>
.learn-scroll {
  height: 100%;
  overflow: auto;
  padding: var(--size-4-6) var(--size-4-6) var(--size-4-8);
}
.learn-head {
  max-width: 880px;
  margin: 0 auto var(--size-4-5);
}
.learn-title-row {
  display: inline-flex;
  align-items: center;
  gap: var(--size-4-2);
  color: var(--text-normal);
}
.learn-title {
  margin: 0;
  font-size: 22px;
  font-weight: 700;
  font-family: var(--font-ui);
}
.learn-lede {
  margin: var(--size-4-2) 0 var(--size-4-4);
  font-size: 13px;
  line-height: 1.7;
  color: var(--text-muted);
}
.learn-lede code {
  font-family: var(--font-monospace, monospace);
  font-size: 12px;
  background: var(--background-modifier-hover);
  padding: 1px 4px;
  border-radius: var(--radius-s);
}
.learn-actions {
  display: inline-flex;
  align-items: center;
  gap: var(--size-4-2);
  flex-wrap: wrap;
}
.btn {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 5px 12px;
  border: 1px solid var(--background-modifier-border);
  border-radius: var(--radius-s);
  background: var(--background-secondary);
  color: var(--text-normal);
  font-size: 12px;
  cursor: pointer;
}
.btn.primary {
  background: var(--interactive-accent);
  color: var(--text-on-accent);
  border-color: transparent;
}
.btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
.btn:hover:not(:disabled) {
  opacity: 0.88;
}
.spin {
  animation: cw-spin 0.9s linear infinite;
}
@keyframes cw-spin {
  to {
    transform: rotate(360deg);
  }
}
.learn-stat {
  font-size: 12px;
  color: var(--text-faint);
}
.learn-err,
.learn-msg {
  max-width: 880px;
  margin: 0 auto var(--size-4-3);
  padding: 8px 12px;
  border-radius: var(--radius-s);
  font-size: 12px;
}
.learn-err {
  display: flex;
  align-items: center;
  gap: 6px;
  background: rgba(224, 93, 93, 0.08);
  color: var(--text-error, #e05d5d);
}
.learn-msg {
  background: rgba(78, 157, 104, 0.08);
  color: var(--color-green, #4e9d68);
}
.learn-placeholder {
  max-width: 880px;
  margin: var(--size-4-8) auto;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--size-4-3);
  color: var(--text-faint);
  font-size: 13px;
}
.learn-content {
  max-width: 880px;
  margin: 0 auto;
}
.cand-section {
  margin-bottom: var(--size-4-6);
}
.cand-section-title {
  display: flex;
  align-items: center;
  gap: var(--size-4-2);
  margin: 0 0 var(--size-4-1);
  font-size: 14px;
  font-weight: 600;
  color: var(--text-normal);
  font-family: var(--font-ui);
}
.cand-count {
  font-size: 11px;
  font-weight: 500;
  color: var(--text-faint);
  background: var(--background-modifier-hover);
  padding: 1px 6px;
  border-radius: 8px;
}
.cand-section-hint {
  margin: 0 0 var(--size-4-3);
  font-size: 11px;
  color: var(--text-faint);
}
.cand-list {
  display: flex;
  flex-direction: column;
  gap: var(--size-4-2);
}
.cand-card {
  border: 1px solid var(--background-modifier-border);
  border-radius: var(--radius-m);
  background: var(--background-primary);
  padding: var(--size-4-3);
  transition: border-color 0.12s, background 0.12s;
}
.cand-card.picked {
  border-color: var(--interactive-accent);
  background: var(--background-modifier-active-hover);
}
.cand-card-head {
  display: flex;
  align-items: center;
  gap: var(--size-4-2);
  margin-bottom: var(--size-4-2);
}
.scene-tag {
  font-size: 11px;
  font-weight: 600;
  color: var(--text-accent);
  background: var(--background-modifier-hover);
  padding: 2px 8px;
  border-radius: var(--radius-s);
}
.score {
  font-size: 12px;
  font-weight: 700;
  font-family: var(--font-monospace, monospace);
  padding: 1px 6px;
  border-radius: var(--radius-s);
}
.score-a {
  color: var(--color-green, #4e9d68);
  background: rgba(78, 157, 104, 0.12);
}
.score-b {
  color: var(--text-warning);
  background: rgba(204, 162, 76, 0.12);
}
.score-c {
  color: var(--text-muted);
  background: var(--background-modifier-hover);
}
.src {
  font-size: 11px;
  color: var(--text-faint);
}
.cand-card-head input[type='checkbox'] {
  margin-left: auto;
  width: 15px;
  height: 15px;
  accent-color: var(--interactive-accent);
  cursor: pointer;
}
.cand-body {
  margin: 0;
  font-size: 14px;
  line-height: 1.85;
  color: var(--text-normal);
  font-family: var(--prose-font);
  white-space: pre-wrap;
}
.quote-list {
  display: flex;
  flex-direction: column;
  gap: var(--size-4-1);
}
.quote-card {
  display: flex;
  align-items: flex-start;
  gap: var(--size-4-2);
  border: 1px solid var(--background-modifier-border);
  border-radius: var(--radius-s);
  background: var(--background-primary);
  padding: var(--size-4-2) var(--size-4-3);
  transition: border-color 0.12s, background 0.12s;
}
.quote-card.picked {
  border-color: var(--interactive-accent);
  background: var(--background-modifier-active-hover);
}
.quote-card input[type='checkbox'] {
  margin-top: 2px;
  width: 15px;
  height: 15px;
  accent-color: var(--interactive-accent);
  cursor: pointer;
}
.quote-body {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.quote-text {
  font-size: 14px;
  line-height: 1.7;
  color: var(--text-normal);
  font-family: var(--prose-font);
}
</style>
