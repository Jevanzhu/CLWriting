<script setup lang="ts">
// 文风收割工作台（重设计）：收割前引导 → 收割后概览+场景分组+批量操作。
// learn 规则打分（借机检规则）不涉大模型——始终可用。
// 候选制红线：勾选才入库，品味归人。
import { computed, ref, watch } from 'vue'
import { GraduationCap, Sparkles, PackageCheck, AlertCircle, Check, X } from 'lucide-vue-next'
import { useLearnStore } from '../stores/learn'
import { useTreeStore } from '../stores/tree'
import EmptyState from '../components/ui/EmptyState.vue'
import type { SampleCandidateFE } from '../api/learn'

const props = defineProps<{ bookName: string }>()
const learn = useLearnStore()
const tree = useTreeStore()

// 打分分档：A ≥90 优质，B 75-89 良好，C 60-74 及格
const TIER_A = 90
const TIER_B = 75
function tierOf(score: number): 'a' | 'b' | 'c' {
  if (score >= TIER_A) return 'a'
  if (score >= TIER_B) return 'b'
  return 'c'
}

// 定稿正文章节数（引导提示用）
const chapterCount = computed(
  () => [...tree.byDocId.values()].filter((n) => n.path.startsWith('定稿/正文/')).length,
)

// ── 筛选 ──
const filter = ref<'all' | 'a'>('all')

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

// ── 样章按场景分组（筛选后、组内打分降序、组间均分降序）──
const sampleGroups = computed(() => {
  const list = filter.value === 'a'
    ? learn.samples.filter((s) => s.打分 >= TIER_A)
    : learn.samples
  const map = new Map<string, SampleCandidateFE[]>()
  for (const s of list) {
    const arr = map.get(s.场景)
    if (arr) arr.push(s)
    else map.set(s.场景, [s])
  }
  return [...map.entries()]
    .map(([场景, items]) => {
      items.sort((x, y) => y.打分 - x.打分)
      return {
        场景,
        items,
        count: items.length,
        avg: Math.round(items.reduce((s, x) => s + x.打分, 0) / items.length),
        allPicked: items.every((s) => learn.isSamplePicked(s.正文)),
      }
    })
    .sort((a, b) => b.avg - a.avg)
})

// ── 批量操作 ──
function selectAllTierA(): void {
  for (const s of learn.samples) {
    if (s.打分 >= TIER_A && !learn.isSamplePicked(s.正文)) learn.toggleSample(s.正文)
  }
}
function toggleGroup(items: SampleCandidateFE[]): void {
  const allIn = items.every((s) => learn.isSamplePicked(s.正文))
  for (const s of items) {
    if (allIn === learn.isSamplePicked(s.正文)) learn.toggleSample(s.正文)
  }
}
function clearAllPicks(): void {
  learn.clearPicks()
}

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
            <span>{{ learn.committing ? '入库中…' : `入库（${learn.pickedCount}）` }}</span>
          </button>
        </div>
      </div>
      <p class="learn-lede">
        扫描定稿正文，按机检规则打分 + 场景预归类，产出样章 / 金句候选。
        作者勾选后才入库到 <code>文风 / 样章库</code>——品味归人，不自动入库。
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
      :text="chapterCount > 0 ? `点击「收割候选」扫描 ${chapterCount} 章定稿正文。` : '当前没有定稿正文可收割——先写正文并定稿。'"
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
      <section v-if="learn.samples.length" class="sec">
        <div class="sec-bar">
          <h2 class="sec-title">样章候选</h2>
          <div class="filter-tabs">
            <button :class="{ on: filter === 'all' }" @click="filter = 'all'">全部</button>
            <button :class="{ on: filter === 'a' }" @click="filter = 'a'">仅 A 级（{{ scoreStats.a }}）</button>
          </div>
          <div class="batch-ops">
            <button class="text-btn" @click="selectAllTierA">全选 A 级</button>
            <button class="text-btn" @click="clearAllPicks">清空勾选</button>
          </div>
        </div>

        <div v-for="g in sampleGroups" :key="g.场景" class="scene-group">
          <div class="group-head" @click="toggleGroup(g.items)">
            <span class="scene-name">{{ g.场景 }}</span>
            <span class="group-meta">{{ g.count }} 篇 · 均分 {{ g.avg }}</span>
            <span class="group-toggle" :class="{ all: g.allPicked }">
              <Check :size="12" />{{ g.allPicked ? '已全选' : '全选' }}
            </span>
          </div>
          <div class="cand-list">
            <div
              v-for="s in g.items"
              :key="s.正文"
              class="cand-card"
              :class="[tierOf(s.打分), { picked: learn.isSamplePicked(s.正文) }]"
            >
              <div class="cand-head">
                <span class="score-badge">{{ s.打分 }}</span>
                <span class="src">{{ s.出处 }}</span>
                <input
                  type="checkbox"
                  :checked="learn.isSamplePicked(s.正文)"
                  @change="learn.toggleSample(s.正文)"
                  @click.stop
                />
              </div>
              <p class="cand-body">{{ s.正文 }}</p>
              <p v-if="s.技法指令" class="cand-tech">技法 · {{ s.技法指令 }}</p>
            </div>
          </div>
        </div>
      </section>

      <!-- 金句区 -->
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

      <!-- 无合格候选 -->
      <EmptyState
        v-if="!learn.samples.length && !learn.quotes.length"
        :icon="PackageCheck"
        text="本轮无合格候选——定稿正文打分普遍偏低或无特征短句。"
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

/* 区段 */
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

/* 样章区工具栏 */
.sec-bar {
  display: flex;
  align-items: center;
  gap: var(--size-4-3);
  margin-bottom: var(--size-4-4);
  flex-wrap: wrap;
}
.sec-bar .sec-title {
  margin: 0;
}
.filter-tabs {
  display: flex;
  gap: 2px;
  background: var(--background-secondary);
  border-radius: var(--radius-m);
  padding: 2px;
}
.filter-tabs button {
  padding: 3px 10px;
  border: none;
  background: none;
  border-radius: var(--radius-s);
  font-size: var(--font-size-xs);
  color: var(--text-muted);
  cursor: pointer;
  transition: all var(--dur-fast) var(--ease-out);
}
.filter-tabs button.on {
  background: var(--background-primary);
  color: var(--text-normal);
  box-shadow: var(--shadow-s);
}
.batch-ops {
  display: flex;
  gap: var(--size-4-2);
  margin-left: auto;
}
.text-btn {
  padding: 3px 8px;
  border: none;
  background: none;
  font-size: var(--font-size-xs);
  color: var(--text-muted);
  cursor: pointer;
  border-radius: var(--radius-s);
  transition: all var(--dur-fast) var(--ease-out);
}
.text-btn:hover {
  color: var(--text-accent);
  background: var(--background-modifier-hover);
}

/* 场景分组 */
.scene-group {
  margin-bottom: var(--size-4-4);
}
.group-head {
  display: flex;
  align-items: center;
  gap: var(--size-4-2);
  padding: 5px 10px;
  margin-bottom: var(--size-4-2);
  background: var(--background-secondary);
  border-radius: var(--radius-s);
  cursor: pointer;
  transition: background var(--dur-fast) var(--ease-out);
}
.group-head:hover {
  background: var(--background-modifier-hover);
}
.scene-name {
  font-size: var(--font-size-s);
  font-weight: 600;
  color: var(--text-normal);
}
.group-meta {
  font-size: var(--font-size-xs);
  color: var(--text-muted);
}
.group-toggle {
  margin-left: auto;
  display: inline-flex;
  align-items: center;
  gap: 3px;
  font-size: var(--font-size-xs);
  color: var(--text-muted);
}
.group-toggle.all {
  color: var(--text-accent);
}

/* 样章候选卡 */
.cand-list {
  display: flex;
  flex-direction: column;
  gap: var(--size-4-2);
}
.cand-card {
  border: 1px solid var(--background-modifier-border);
  border-left: 3px solid var(--background-modifier-border);
  border-radius: var(--radius-m);
  background: var(--background-primary);
  padding: var(--size-4-3);
  transition: border-color var(--dur-fast) var(--ease-out), background var(--dur-fast) var(--ease-out);
}
/* 左竖线按档着色 */
.cand-card.a { border-left-color: var(--dv-good); }
.cand-card.b { border-left-color: var(--dv-warn); }
.cand-card.c { border-left-color: var(--background-modifier-border-active); }
.cand-card.picked {
  background: var(--background-modifier-active-hover);
  border-color: var(--interactive-accent);
  border-left-color: var(--interactive-accent);
}
.cand-head {
  display: flex;
  align-items: center;
  gap: var(--size-4-2);
  margin-bottom: var(--size-4-2);
}
.score-badge {
  font-size: var(--font-size-s);
  font-weight: 700;
  font-variant-numeric: tabular-nums;
  font-family: var(--font-monospace);
  min-width: 30px;
  text-align: center;
  padding: 1px 6px;
  border-radius: var(--radius-s);
}
.cand-card.a .score-badge {
  color: var(--dv-good);
  background: color-mix(in srgb, var(--dv-good) 14%, transparent);
}
.cand-card.b .score-badge {
  color: var(--dv-warn);
  background: color-mix(in srgb, var(--dv-warn) 14%, transparent);
}
.cand-card.c .score-badge {
  color: var(--text-muted);
  background: var(--background-modifier-hover);
}
.src {
  font-size: var(--font-size-xs);
  color: var(--text-faint);
}
.cand-head input[type='checkbox'] {
  margin-left: auto;
  width: 15px;
  height: 15px;
  accent-color: var(--interactive-accent);
  cursor: pointer;
}
.cand-body {
  margin: 0;
  font-size: var(--font-size-m);
  line-height: 1.85;
  color: var(--text-normal);
  font-family: var(--prose-font);
  white-space: pre-wrap;
}
.cand-tech {
  margin: var(--size-4-2) 0 0;
  font-size: var(--font-size-xs);
  color: var(--text-faint);
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
}
.quote-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.picked-mark {
  color: var(--text-accent);
}
</style>
