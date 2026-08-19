<script setup lang="ts">
// 文风收割工作台（重设计）：收割前引导 → 收割后概览+场景分组+批量操作。
// learn 规则打分（借机检规则）不涉大模型——始终可用。
// 候选制红线：勾选才入库，品味归人。
// hh §八-16 拆分：样章候选区 → learn/SampleCandidateList，金句区 → learn/QuoteCardGrid
//（纯搬家，DOM 不变）；分档 tierOf 单源 shared/learn-tier。本视图留头部/反馈条/概览编排。
import { computed, ref, watch } from 'vue'
import { GraduationCap, Sparkles, PackageCheck, AlertCircle, Check, X } from 'lucide-vue-next'
import { useLearnStore } from '../stores/learn'
import { useTreeStore } from '../stores/tree'
import { tierOf } from '../shared/learn-tier'
import EmptyState from '../components/ui/EmptyState.vue'
import SampleCandidateList from '../components/learn/SampleCandidateList.vue'
import QuoteCardGrid from '../components/learn/QuoteCardGrid.vue'

const props = defineProps<{ bookName: string }>()
const learn = useLearnStore()
const tree = useTreeStore()

// 定稿正文章节数（引导提示用）
const chapterCount = computed(
  () => [...tree.byDocId.values()].filter((n) => n.path.startsWith('写作/正文/')).length,
)

// ── 打分分布统计 ──
const scoreStats = computed(() => {
  let a = 0, b = 0, c = 0
  for (const s of learn.samples) {
    const t = tierOf(s.打分)
    if (t === 'a') a++
    else if (t === 'b') b++
    else c++
  }
  return { a, b, c, total: learn.samples.length }
})

// 场景覆盖数
const sceneCount = computed(() => new Set(learn.samples.map((s) => s.场景)).size)

// ── 入库反馈条（可关闭，新结果时自动恢复）──
const commitDismissed = ref(false)
watch(() => learn.commitMessage, () => { commitDismissed.value = false })
const showCommit = computed(() => !!learn.commitMessage && !commitDismissed.value)

async function onHarvest(): Promise<void> {
  await learn.harvest(props.bookName)
}
async function onCommit(): Promise<void> {
  await learn.commit(props.bookName)
}
</script>

<template>
  <div class="learn-scroll">
    <!-- 工作台头 -->
    <header class="learn-head">
      <div class="head-top">
        <div class="head-left">
          <h1 class="learn-title">文风收割</h1>
          <span v-if="chapterCount > 0" class="chap-hint">{{ chapterCount }} 章定稿可收割</span>
        </div>
        <div class="head-actions">
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
            <span>{{ learn.committing ? '收录中…' : `收录（${learn.pickedCount}）` }}</span>
          </button>
        </div>
      </div>
      <p class="learn-lede">
        通读定稿正文，按校对规则打分并按场景归类，生成样章和金句候选。
        作者勾选后才收录到文风样章库——品味归人，不自动收录。
      </p>
    </header>

    <!-- 入库反馈条 -->
    <div v-if="showCommit" class="banner ok">
      <Check :size="14" />
      <span>{{ learn.commitMessage }}</span>
      <button class="banner-close" @click="commitDismissed = true"><X :size="13" /></button>
    </div>
    <!-- 错误条 -->
    <div v-if="learn.error" class="banner err">
      <AlertCircle :size="14" />
      <span>{{ learn.error }}</span>
    </div>

    <!-- 空状态 -->
    <EmptyState
      v-if="!learn.hasResult && !learn.loading && !learn.error"
      :icon="GraduationCap"
      :text="chapterCount > 0 ? `点击「收割候选」分析 ${chapterCount} 章定稿正文。` : '当前没有定稿正文可收割——先写正文并定稿。'"
      class="learn-empty"
    />

    <!-- 收割结果 -->
    <div v-if="learn.hasResult" class="learn-body">
      <!-- 概览：打分分布 + 统计 -->
      <div v-if="learn.samples.length" class="overview">
        <div class="dist-bar">
          <div class="dist-seg a" :style="{ flex: scoreStats.a }">
            <span class="dist-label">A</span><span class="dist-num">{{ scoreStats.a }}</span>
          </div>
          <div class="dist-seg b" :style="{ flex: scoreStats.b }">
            <span class="dist-label">B</span><span class="dist-num">{{ scoreStats.b }}</span>
          </div>
          <div class="dist-seg c" :style="{ flex: scoreStats.c }">
            <span class="dist-label">C</span><span class="dist-num">{{ scoreStats.c }}</span>
          </div>
        </div>
        <div class="overview-meta">
          样章 {{ scoreStats.total }} · 金句 {{ learn.quotes.length }} · {{ sceneCount }} 场景
        </div>
      </div>

      <!-- 样章区 -->
      <SampleCandidateList />

      <!-- 金句区 -->
      <QuoteCardGrid />

      <!-- 无合格候选 -->
      <EmptyState
        v-if="!learn.samples.length && !learn.quotes.length"
        :icon="PackageCheck"
        text="这次没有合格候选——定稿正文得分普遍偏低，或缺少有特色的短句。"
      />
    </div>
  </div>
</template>

<style scoped>
.learn-scroll {
  height: 100%;
  overflow: auto;
  padding: var(--size-4-6) var(--size-4-6) var(--size-4-8);
}

/* ── 工作台头 ── */
.learn-head {
  max-width: 920px;
  margin: 0 auto var(--size-4-4);
}
.head-top {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: var(--size-4-3);
  flex-wrap: wrap;
}
.head-left {
  display: flex;
  align-items: baseline;
  gap: var(--size-4-3);
}
.learn-title {
  margin: 0;
  font-size: var(--font-size-2xl);
  font-weight: 700;
  color: var(--text-normal);
}
.chap-hint {
  font-size: var(--font-size-s);
  color: var(--text-muted);
}
.head-actions {
  display: flex;
  gap: var(--size-4-2);
}
.learn-lede {
  margin: var(--size-4-2) 0 0;
  font-size: var(--font-size-m);
  line-height: 1.7;
  color: var(--text-muted);
}
.learn-lede code {
  font-family: var(--font-monospace);
  font-size: var(--font-size-s);
  background: var(--background-modifier-hover);
  padding: 1px 5px;
  border-radius: var(--radius-s);
}

/* 按钮 */
.btn {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 6px 14px;
  border: 1px solid var(--background-modifier-border);
  border-radius: var(--radius-m);
  background: var(--background-primary);
  color: var(--text-normal);
  font-size: var(--font-size-s);
  cursor: pointer;
  transition: all var(--dur-fast) var(--ease-out);
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
  border-color: var(--background-modifier-border-hover);
}
.btn.primary:hover:not(:disabled) {
  background: var(--interactive-accent-hover);
}
.spin {
  animation: cw-spin 0.9s linear infinite;
}
@keyframes cw-spin {
  to { transform: rotate(360deg); }
}

/* 反馈条 */
.banner {
  max-width: 920px;
  margin: 0 auto var(--size-4-3);
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 8px 14px;
  border-radius: var(--radius-m);
  font-size: var(--font-size-s);
}
.banner.ok {
  background: color-mix(in srgb, var(--dv-good) 12%, transparent);
  color: var(--dv-good);
}
.banner.err {
  background: color-mix(in srgb, var(--text-error) 10%, transparent);
  color: var(--text-error);
}
.banner-close {
  margin-left: auto;
  display: flex;
  background: none;
  border: none;
  color: inherit;
  opacity: 0.5;
  cursor: pointer;
}
.banner-close:hover {
  opacity: 1;
}

.learn-empty {
  max-width: 920px;
  margin: var(--size-4-8) auto;
}

/* ── 结果区 ── */
.learn-body {
  max-width: 920px;
  margin: 0 auto;
}

/* 概览：打分分布条 */
.overview {
  display: flex;
  align-items: center;
  gap: var(--size-4-4);
  margin-bottom: var(--size-4-5);
  flex-wrap: wrap;
}
.dist-bar {
  display: flex;
  flex: 1 1 280px;
  height: 30px;
  gap: 2px;
  border-radius: var(--radius-s);
  overflow: hidden;
}
.dist-seg {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  min-width: 0;
  font-weight: 600;
  transition: flex var(--dur-slow) var(--ease-out);
}
.dist-label {
  font-size: var(--font-size-xs);
}
.dist-num {
  font-size: var(--font-size-s);
  font-variant-numeric: tabular-nums;
}
.dist-seg.a {
  background: color-mix(in srgb, var(--dv-good) 18%, transparent);
  color: var(--dv-good);
}
.dist-seg.b {
  background: color-mix(in srgb, var(--dv-warn) 18%, transparent);
  color: var(--dv-warn);
}
.dist-seg.c {
  background: var(--background-modifier-hover);
  color: var(--text-muted);
}
.overview-meta {
  font-size: var(--font-size-s);
  color: var(--text-muted);
  white-space: nowrap;
}


</style>
