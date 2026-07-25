<script setup lang="ts">
// 分析面板（M12 块4 B4.0 骨架 + B4.1 体验分 + B4.2 情绪曲线 + B4.3 钩子密度）：
// 按 kind 读信封存量 → 各卡渲染（过期标）+ 逐 kind 重新分析（aiOff 置灰）。
// 文风总结（B4.4）占位。生成与展示解耦：AI 不可达时存量照常展示。
import { computed, watch } from 'vue'
import { Sparkles, Activity, Anchor, Feather, RefreshCw, AlertCircle, Clock } from 'lucide-vue-next'
import { useAnalysisStore, type KindSlot } from '../../stores/analysis'
import { useWorkspaceStore } from '../../stores/workspace'
import { useTreeStore } from '../../stores/tree'
import { useUiStore } from '../../stores/ui'
import { formKindOf } from '../../shared/words'
import type { AnalysisKindFE } from '../../api/analysis'

const props = defineProps<{ bookName: string }>()
const analysis = useAnalysisStore()
const ws = useWorkspaceStore()
const tree = useTreeStore()
const ui = useUiStore()

const docId = computed(() => ws.activeDocId)
const node = computed(() => (docId.value ? tree.byDocId.get(docId.value) : undefined))
const isReviewable = computed(() => {
  if (!node.value) return false
  if (formKindOf(node.value.path) === 'chapter') return true
  return /^工作区\/草稿-\d+\.md$/.test(node.value.path)
})
const aiOff = computed(() => ui.aiAvailable === false)

// 各 kind payload 断言
interface ScorePayload {
  score: number
  verdict: string
  dims: { 爽点: number; 节奏感: number; 拖沓: number }
}
interface EmotionPoint {
  seg: string
  emotion: number
  label: string
}
interface HooksPayload {
  hooks: { pos: string; type: string; strength: number; note: string }[]
  density: string
}

const scoreSlot = computed<KindSlot>(() => analysis.byKind.score)
const emotionSlot = computed<KindSlot>(() => analysis.byKind.emotion)
const hooksSlot = computed<KindSlot>(() => analysis.byKind.hooks)
const scorePayload = computed(() => scoreSlot.value.envelope?.payload as ScorePayload | undefined)
const emotionPayload = computed(() => emotionSlot.value.envelope?.payload as EmotionPoint[] | undefined)
const hooksPayload = computed(() => hooksSlot.value.envelope?.payload as HooksPayload | undefined)

function slotEnvelopeMeta(slot: KindSlot): string {
  const t = slot.envelope?.generatedAt
  if (!t) return ''
  return new Date(t).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
}

async function loadAll(): Promise<void> {
  if (!docId.value || !isReviewable.value) return
  // 三 kind 并发读存量（AI 不可达时也只读盘，不触发生成）
  await Promise.all([
    analysis.load(props.bookName, docId.value, 'score'),
    analysis.load(props.bookName, docId.value, 'emotion'),
    analysis.load(props.bookName, docId.value, 'hooks'),
  ])
}
watch(docId, () => {
  analysis.clear()
  void loadAll()
}, { immediate: true })

async function runKind(kind: AnalysisKindFE): Promise<void> {
  if (!docId.value) return
  await analysis.run(props.bookName, docId.value, kind)
}

// 情绪 SVG 折线坐标（emotion -2..2 → y；seg 顺序 → x）
const EMOTION_W = 200
const EMOTION_H = 64
const EMOTION_PAD = 10
function emotionX(i: number, n: number): number {
  if (n <= 1) return EMOTION_W / 2
  return EMOTION_PAD + (i / (n - 1)) * (EMOTION_W - 2 * EMOTION_PAD)
}
function emotionY(v: number): number {
  const clamped = Math.max(-2, Math.min(2, v))
  return EMOTION_PAD + (1 - (clamped + 2) / 4) * (EMOTION_H - 2 * EMOTION_PAD)
}
const emotionLine = computed(() => {
  const arr = emotionPayload.value ?? []
  return arr.map((d, i) => `${emotionX(i, arr.length)},${emotionY(d.emotion)}`).join(' ')
})

// dims 进度条配色：爽点/节奏感 高=好（绿）；拖沓 高=差（橙）
function dimColor(label: string): string {
  return label === '拖沓' ? 'var(--color-orange, #d97706)' : 'var(--color-green, #4e9d68)'
}
function dimWidth(label: string, v: number): string {
  const pct = label === '拖沓' ? (10 - v) * 10 : v * 10
  return `${Math.max(0, Math.min(100, pct))}%`
}
function strengthDots(n: number): number[] {
  return Array.from({ length: 5 }, (_, i) => i + 1)
}
</script>

<template>
  <section v-if="!isReviewable" class="ap-hint">分析仅适用于正文 / 草稿文档。</section>

  <section v-else class="analysis-panel">
    <!-- 过期条（正文变更 → 存量标过期；任一 kind stale 即提示） -->
    <div v-if="scoreSlot.envelope && scoreSlot.stale" class="ap-stale">
      <AlertCircle :size="13" />
      <span>正文已变更，以下为旧版存量（可重新分析）。</span>
    </div>

    <!-- 体验分卡（B4.1） -->
    <div class="ap-card">
      <div class="ap-card-head">
        <div class="ap-card-title"><Sparkles :size="14" /><span>体验分</span></div>
        <button class="ap-run" :disabled="aiOff || analysis.loading === 'score'" @click="runKind('score')">
          <RefreshCw :size="12" :class="{ spin: analysis.loading === 'score' }" />
          <span>{{ analysis.loading === 'score' ? '分析中…' : '重新分析' }}</span>
        </button>
      </div>
      <div v-if="aiOff && !scoreSlot.envelope" class="ap-empty">AI 不可达，暂无体验分。</div>
      <div v-else-if="analysis.error && analysis.loading === null && !scorePayload" class="ap-error">
        <AlertCircle :size="13" /><span>{{ analysis.error }}</span>
      </div>
      <div v-else-if="!scoreSlot.envelope" class="ap-empty">暂无体验分{{ aiOff ? '' : '，点「重新分析」生成' }}。</div>
      <div v-else-if="scorePayload" class="ap-score-body">
        <div class="ap-score-row">
          <div class="ap-score-num">{{ scorePayload.score }}</div>
          <div class="ap-score-meta">
            <div class="ap-verdict">{{ scorePayload.verdict }}</div>
            <div v-if="slotEnvelopeMeta(scoreSlot)" class="ap-gen">
              <Clock :size="11" /><span>{{ slotEnvelopeMeta(scoreSlot) }} · {{ scoreSlot.envelope.model }}</span>
            </div>
          </div>
        </div>
        <div class="ap-dims">
          <div v-for="(v, k) in scorePayload.dims" :key="k" class="ap-dim">
            <div class="ap-dim-head">
              <span>{{ k }}</span>
              <span class="ap-dim-val">{{ v }}<span class="ap-dim-max">/10</span></span>
            </div>
            <div class="ap-dim-track">
              <div class="ap-dim-fill" :style="{ width: dimWidth(String(k), Number(v)), background: dimColor(String(k)) }" />
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- 情绪曲线卡（B4.2） -->
    <div class="ap-card">
      <div class="ap-card-head">
        <div class="ap-card-title"><Activity :size="14" /><span>情绪曲线</span></div>
        <button class="ap-run" :disabled="aiOff || analysis.loading === 'emotion'" @click="runKind('emotion')">
          <RefreshCw :size="12" :class="{ spin: analysis.loading === 'emotion' }" />
          <span>{{ analysis.loading === 'emotion' ? '分析中…' : '重新分析' }}</span>
        </button>
      </div>
      <div v-if="aiOff && !emotionSlot.envelope" class="ap-empty">AI 不可达，暂无情绪曲线。</div>
      <div v-else-if="!emotionSlot.envelope" class="ap-empty">暂无情绪曲线{{ aiOff ? '' : '，点「重新分析」生成' }}。</div>
      <div v-else-if="emotionPayload && emotionPayload.length" class="ap-emotion-body">
        <svg :viewBox="`0 0 ${EMOTION_W} ${EMOTION_H}`" class="ap-emotion-svg" preserveAspectRatio="none">
          <line :x1="EMOTION_PAD" :y1="emotionY(0)" :x2="EMOTION_W - EMOTION_PAD" :y2="emotionY(0)" class="ap-emotion-zero" />
          <polyline :points="emotionLine" class="ap-emotion-line" />
          <circle
            v-for="(d, i) in emotionPayload"
            :key="i"
            :cx="emotionX(i, emotionPayload.length)"
            :cy="emotionY(d.emotion)"
            r="2.5"
            class="ap-emotion-dot"
          />
        </svg>
        <div class="ap-emotion-legend">
          <span v-for="(d, i) in emotionPayload" :key="i" class="ap-emotion-seg">
            <span class="ap-emotion-label">{{ d.label }}</span>
            <span class="ap-emotion-val">{{ d.emotion > 0 ? '+' : '' }}{{ d.emotion }}</span>
          </span>
        </div>
      </div>
      <div v-else class="ap-empty">情绪曲线样本不足。</div>
    </div>

    <!-- 钩子密度卡（B4.3） -->
    <div class="ap-card">
      <div class="ap-card-head">
        <div class="ap-card-title"><Anchor :size="14" /><span>钩子密度</span></div>
        <div class="ap-head-right">
          <span v-if="hooksPayload" class="ap-density" :class="'density-' + hooksPayload.density">{{ hooksPayload.density }}</span>
          <button class="ap-run" :disabled="aiOff || analysis.loading === 'hooks'" @click="runKind('hooks')">
            <RefreshCw :size="12" :class="{ spin: analysis.loading === 'hooks' }" />
            <span>{{ analysis.loading === 'hooks' ? '分析中…' : '重新分析' }}</span>
          </button>
        </div>
      </div>
      <div v-if="aiOff && !hooksSlot.envelope" class="ap-empty">AI 不可达，暂无钩子分析。</div>
      <div v-else-if="!hooksSlot.envelope" class="ap-empty">暂无钩子分析{{ aiOff ? '' : '，点「重新分析」生成' }}。</div>
      <div v-else-if="hooksPayload && hooksPayload.hooks.length" class="ap-hooks-list">
        <div v-for="(h, i) in hooksPayload.hooks" :key="i" class="ap-hook">
          <div class="ap-hook-head">
            <span class="ap-hook-pos">{{ h.pos }}</span>
            <span class="ap-hook-type">{{ h.type }}</span>
            <span class="ap-hook-strength">
              <i v-for="d in strengthDots(h.strength)" :key="d" class="ap-strength-dot" :class="{ on: d <= h.strength }" />
            </span>
          </div>
          <div v-if="h.note" class="ap-hook-note">{{ h.note }}</div>
        </div>
      </div>
      <div v-else class="ap-empty">未识别到明显钩子。</div>
    </div>

    <!-- 文风总结卡（B4.4 占位） -->
    <div class="ap-card ap-card--placeholder">
      <div class="ap-card-title"><Feather :size="14" /><span>文风总结</span></div>
      <div class="ap-placeholder">本地 stats + AI 漂移建议（M12 块4 B4.4）</div>
    </div>
  </section>
</template>

<style scoped>
.analysis-panel {
  display: flex;
  flex-direction: column;
  gap: var(--size-4-3);
}
.ap-hint {
  font-size: 12px;
  color: var(--text-faint);
}
.ap-stale {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  font-size: 11px;
  color: var(--color-orange, #d97706);
  background: rgba(217, 119, 6, 0.08);
  border: 1px solid rgba(217, 119, 6, 0.2);
  border-radius: var(--radius-s);
  padding: 6px 8px;
}
.ap-card {
  border: 1px solid var(--background-modifier-border);
  border-radius: var(--radius-m);
  background: var(--background-primary);
  padding: var(--size-4-3);
}
.ap-card--placeholder {
  opacity: 0.6;
}
.ap-card-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: var(--size-4-2);
}
.ap-head-right {
  display: inline-flex;
  align-items: center;
  gap: 8px;
}
.ap-card-title {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  font-weight: 600;
  color: var(--text-normal);
}
.ap-run {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 3px 8px;
  border: 1px solid var(--background-modifier-border);
  border-radius: var(--radius-s);
  background: var(--interactive-accent);
  color: var(--text-on-accent);
  font-size: 11px;
  cursor: pointer;
}
.ap-run:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
.ap-run:hover:not(:disabled) {
  opacity: 0.88;
}
.spin {
  animation: ap-spin 0.9s linear infinite;
}
@keyframes ap-spin {
  to {
    transform: rotate(360deg);
  }
}
.ap-empty,
.ap-error,
.ap-placeholder {
  font-size: 12px;
  color: var(--text-faint);
  line-height: 1.6;
}
.ap-error {
  display: flex;
  gap: 6px;
  color: var(--text-error, #e05d5d);
}
/* 体验分 */
.ap-score-row {
  display: flex;
  align-items: center;
  gap: var(--size-4-3);
  margin-bottom: var(--size-4-3);
}
.ap-score-num {
  font-size: 38px;
  font-weight: 700;
  line-height: 1;
  color: var(--interactive-accent);
}
.ap-score-meta {
  flex: 1;
}
.ap-verdict {
  font-size: 13px;
  color: var(--text-normal);
  line-height: 1.5;
}
.ap-gen {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  margin-top: 4px;
  font-size: 11px;
  color: var(--text-faint);
}
.ap-dims {
  display: flex;
  flex-direction: column;
  gap: var(--size-4-2);
}
.ap-dim-head {
  display: flex;
  justify-content: space-between;
  font-size: 11px;
  color: var(--text-muted);
  margin-bottom: 3px;
}
.ap-dim-val {
  font-weight: 600;
  color: var(--text-normal);
}
.ap-dim-max {
  color: var(--text-faint);
  font-weight: 400;
}
.ap-dim-track {
  height: 5px;
  background: var(--background-modifier-border);
  border-radius: 3px;
  overflow: hidden;
}
.ap-dim-fill {
  height: 100%;
  border-radius: 3px;
  transition: width 0.3s;
}
/* 情绪曲线 */
.ap-emotion-body {
  display: flex;
  flex-direction: column;
  gap: var(--size-4-2);
}
.ap-emotion-svg {
  width: 100%;
  height: 64px;
}
.ap-emotion-zero {
  stroke: var(--background-modifier-border);
  stroke-width: 1;
  stroke-dasharray: 3 3;
}
.ap-emotion-line {
  fill: none;
  stroke: var(--interactive-accent);
  stroke-width: 1.5;
}
.ap-emotion-dot {
  fill: var(--interactive-accent);
}
.ap-emotion-legend {
  display: flex;
  flex-wrap: wrap;
  gap: 6px 12px;
}
.ap-emotion-seg {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 11px;
  color: var(--text-muted);
}
.ap-emotion-label {
  color: var(--text-normal);
}
.ap-emotion-val {
  color: var(--text-faint);
  font-variant-numeric: tabular-nums;
}
/* 钩子密度 */
.ap-density {
  font-size: 11px;
  padding: 1px 8px;
  border-radius: 10px;
  background: var(--background-modifier-border);
  color: var(--text-normal);
}
.density-密 {
  background: rgba(224, 93, 93, 0.15);
  color: var(--text-error, #e05d5d);
}
.density-疏 {
  background: rgba(217, 119, 6, 0.15);
  color: var(--color-orange, #d97706);
}
.density-中 {
  background: rgba(78, 157, 104, 0.15);
  color: var(--color-green, #4e9d68);
}
.ap-hooks-list {
  display: flex;
  flex-direction: column;
  gap: var(--size-4-2);
}
.ap-hook {
  padding: 6px 8px;
  background: var(--background-secondary);
  border-radius: var(--radius-s);
}
.ap-hook-head {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 11px;
}
.ap-hook-pos {
  font-weight: 600;
  color: var(--text-normal);
}
.ap-hook-type {
  padding: 1px 6px;
  border-radius: 8px;
  background: var(--background-modifier-border);
  color: var(--text-muted);
  font-size: 10px;
}
.ap-hook-strength {
  display: inline-flex;
  gap: 2px;
  margin-left: auto;
}
.ap-strength-dot {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--background-modifier-border);
  display: inline-block;
}
.ap-strength-dot.on {
  background: var(--interactive-accent);
}
.ap-hook-note {
  margin-top: 3px;
  font-size: 11px;
  color: var(--text-muted);
  line-height: 1.5;
}
</style>
