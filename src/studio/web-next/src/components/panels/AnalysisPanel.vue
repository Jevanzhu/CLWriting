<script setup lang="ts">
// 分析面板（M12 块4 四载荷：体验分/情绪曲线/钩子密度/文风总结 + 情绪卡节奏上下文）：
// 按 kind 读信封存量 → 各卡渲染（过期标）+ 逐 kind 重新分析（aiOff 置灰）。
// 生成与展示解耦：AI 不可达时存量照常展示。
import { computed, ref, watch } from 'vue'
import { Sparkles, Activity, Anchor, Feather, RefreshCw, AlertCircle, Clock, Gauge, Tag } from 'lucide-vue-next'
import { useAnalysisStore, type KindSlot } from '../../stores/analysis'
import { useWorkspaceStore } from '../../stores/workspace'
import { useTreeStore } from '../../stores/tree'
import { useDocStore } from '../../stores/doc'
import { useUiStore } from '../../stores/ui'
import { formKindOf, parseFmFields } from '../../shared/words'
import { autotag, type AnalysisKindFE } from '../../api/analysis'
import { updateDocMeta } from '../../api/documents'
import { getRhythm, type RhythmResult } from '../../api/rhythm'
import EmptyState from '../ui/EmptyState.vue'

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

const doc = useDocStore()
const entry = computed(() => (docId.value ? doc.get(docId.value) : undefined))
/** 章节标签字段（AI 判定：钩子/情绪/场景，写入正文 fm 供 rhythm 读取）。 */
const TAG_FIELDS = [
  { key: '钩子类型', label: '钩子类型' },
  { key: '钩子强弱', label: '钩子强弱' },
  { key: '情绪定位', label: '情绪定位' },
  { key: '场景', label: '场景' },
] as const
const tagValues = computed<Record<string, string>>(() => {
  if (!entry.value) return {}
  const parsed = parseFmFields(entry.value.content)
  const out: Record<string, string> = {}
  for (const f of TAG_FIELDS) out[f.key] = parsed[f.key] ?? ''
  return out
})
const tagging = ref(false)
async function onAutoTag(): Promise<void> {
  if (!docId.value || tagging.value) return
  tagging.value = true
  try {
    const tags = await autotag(props.bookName, docId.value)
    await updateDocMeta(props.bookName, docId.value, tags)
    await doc.refresh(docId.value)
    ui.toast('AI 识别完成', 'success')
  } catch (err) {
    ui.toast(err instanceof Error ? err.message : String(err), 'error')
  } finally {
    tagging.value = false
  }
}

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
interface StylePayload {
  drift: string
  口癖: string[]
  重复度评价: string
  建议: string[]
}

const scoreSlot = computed<KindSlot>(() => analysis.byKind.score)
const emotionSlot = computed<KindSlot>(() => analysis.byKind.emotion)
const hooksSlot = computed<KindSlot>(() => analysis.byKind.hooks)
const styleSlot = computed<KindSlot>(() => analysis.byKind.style)
const scorePayload = computed(() => scoreSlot.value.envelope?.payload as ScorePayload | undefined)
const emotionPayload = computed(() => emotionSlot.value.envelope?.payload as EmotionPoint[] | undefined)
const hooksPayload = computed(() => hooksSlot.value.envelope?.payload as HooksPayload | undefined)
const stylePayload = computed(() => styleSlot.value.envelope?.payload as StylePayload | undefined)

// 节奏上下文（情绪卡叠加：读 rhythm 全书 → 取当前章 chapterDiff 行）
const rhythm = ref<RhythmResult | null>(null)
const showRhythm = ref(true)
const currentChapter = computed(() => {
  const m = node.value?.path.match(/(\d+)-/)
  return m ? parseInt(m[1] ?? '', 10) : null
})
const rhythmRow = computed(() => {
  const r = rhythm.value
  if (!r || r.kind !== 'long' || currentChapter.value == null) return null
  return r.chapterDiff.find((row) => row.章号 === currentChapter.value) ?? null
})

function slotEnvelopeMeta(slot: KindSlot): string {
  const t = slot.envelope?.generatedAt
  if (!t) return ''
  return new Date(t).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
}

async function loadAll(): Promise<void> {
  if (!docId.value || !isReviewable.value) return
  await Promise.all([
    analysis.load(props.bookName, docId.value, 'score'),
    analysis.load(props.bookName, docId.value, 'emotion'),
    analysis.load(props.bookName, docId.value, 'hooks'),
    analysis.load(props.bookName, docId.value, 'style'),
  ])
}
async function loadRhythm(): Promise<void> {
  try {
    rhythm.value = await getRhythm(props.bookName)
  } catch {
    rhythm.value = null
  }
}
watch(docId, () => {
  analysis.clear()
  rhythm.value = null
  void loadAll()
  void loadRhythm()
}, { immediate: true })

async function runKind(kind: AnalysisKindFE): Promise<void> {
  if (!docId.value) return
  await analysis.run(props.bookName, docId.value, kind)
}

// 情绪 SVG 折线坐标（emotion -2..2 → y；seg 顺序 → x）
const EMOTION_W = 200
const EMOTION_H = 64
const EMOTION_PAD_X = 20 // 左侧留 Y 轴标签空间
const EMOTION_PAD_Y = 10
function emotionX(i: number, n: number): number {
  if (n <= 1) return (EMOTION_W + EMOTION_PAD_X) / 2
  return EMOTION_PAD_X + (i / (n - 1)) * (EMOTION_W - EMOTION_PAD_X - EMOTION_PAD_Y)
}
function emotionY(v: number): number {
  const clamped = Math.max(-2, Math.min(2, v))
  return EMOTION_PAD_Y + (1 - (clamped + 2) / 4) * (EMOTION_H - 2 * EMOTION_PAD_Y)
}
const emotionLine = computed(() => {
  const arr = emotionPayload.value ?? []
  return arr.map((d, i) => `${emotionX(i, arr.length)},${emotionY(d.emotion)}`).join(' ')
})

// dims 进度条配色：爽点/节奏感 高=好（绿）；拖沓 高=差（橙）
function dimColor(label: string): string {
  return label === '拖沓' ? 'var(--dv-warn)' : 'var(--dv-good)'
}
function dimWidth(label: string, v: number): string {
  const pct = label === '拖沓' ? (10 - v) * 10 : v * 10
  return `${Math.max(0, Math.min(100, pct))}%`
}
</script>

<template>
  <section v-if="!isReviewable" class="ap-hint">分析仅适用于正文 / 草稿文档。</section>

  <section v-else class="analysis-panel">
    <!-- 过期条（正文变更 → 存量标过期） -->
    <div v-if="scoreSlot.envelope && scoreSlot.stale" class="ap-stale">
      <AlertCircle :size="13" />
      <span>正文已变更，以下为旧版存量（可重新分析）。</span>
    </div>

    <!-- 章节标签卡（AI 判定：钩子/情绪/场景） -->
    <div class="ap-card">
      <div class="ap-card-head">
        <div class="ap-card-title"><Tag :size="14" /><span>章节标签</span></div>
        <button class="ap-run" :disabled="aiOff || tagging" @click="onAutoTag">
          <RefreshCw :size="12" :class="{ spin: tagging }" />
          <span>{{ tagging ? '识别中…' : 'AI 识别' }}</span>
        </button>
      </div>
      <div class="ap-tags-grid">
        <div v-for="f in TAG_FIELDS" :key="f.key" class="ap-tag-cell">
          <span class="ap-tag-label">{{ f.label }}</span>
          <span v-if="tagValues[f.key]" class="ap-tag-val">{{ tagValues[f.key] }}</span>
          <span v-else class="ap-tag-empty">{{ tagging ? '…' : '—' }}</span>
        </div>
      </div>
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
      <EmptyState v-if="aiOff && !scoreSlot.envelope" :icon="Sparkles" size="compact" text="AI 不可达，暂无体验分。" />
      <EmptyState v-else-if="!scoreSlot.envelope" :icon="Sparkles" size="compact" :text="`暂无体验分${aiOff ? '' : '，点「重新分析」生成'}。`" />
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

    <!-- 情绪曲线卡（B4.2 + 节奏上下文叠加） -->
    <div class="ap-card">
      <div class="ap-card-head">
        <div class="ap-card-title"><Activity :size="14" /><span>情绪曲线</span></div>
        <div class="ap-head-right">
          <label v-if="rhythmRow" class="ap-toggle" data-tip="叠加节奏上下文">
            <input v-model="showRhythm" type="checkbox" />
            <Gauge :size="12" />
          </label>
          <button class="ap-run" :disabled="aiOff || analysis.loading === 'emotion'" @click="runKind('emotion')">
            <RefreshCw :size="12" :class="{ spin: analysis.loading === 'emotion' }" />
            <span>{{ analysis.loading === 'emotion' ? '分析中…' : '重新分析' }}</span>
          </button>
        </div>
      </div>
      <EmptyState v-if="aiOff && !emotionSlot.envelope" :icon="Activity" size="compact" text="AI 不可达，暂无情绪曲线。" />
      <EmptyState v-else-if="!emotionSlot.envelope" :icon="Activity" size="compact" :text="`暂无情绪曲线${aiOff ? '' : '，点「重新分析」生成'}。`" />
      <div v-else-if="emotionPayload && emotionPayload.length" class="ap-emotion-body">
        <svg :viewBox="`0 0 ${EMOTION_W} ${EMOTION_H}`" class="ap-emotion-svg" preserveAspectRatio="none">
          <!-- diverging 渐变：顶部正情绪（橙）→ 零线灰 → 底部负情绪（蓝），沿 y 轴铺色 -->
          <defs>
            <linearGradient id="clw-emotion-grad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" :style="{ stopColor: 'var(--div-pos)' }" />
              <stop offset="50%" :style="{ stopColor: 'var(--div-zero)' }" />
              <stop offset="100%" :style="{ stopColor: 'var(--div-neg)' }" />
            </linearGradient>
          </defs>
          <!-- Y 轴语义标签：+2（正情绪）/ 0（中性）/ −2（负情绪）-->
          <text x="2" :y="emotionY(2) + 3" class="ap-emotion-y">+2</text>
          <text x="2" :y="emotionY(0) + 3" class="ap-emotion-y">0</text>
          <text x="2" :y="emotionY(-2) + 3" class="ap-emotion-y">−2</text>
          <line :x1="EMOTION_PAD_X" :y1="emotionY(0)" :x2="EMOTION_W - EMOTION_PAD_Y" :y2="emotionY(0)" class="ap-emotion-zero" />
          <polyline :points="emotionLine" class="ap-emotion-line" style="stroke: url(#clw-emotion-grad)" />
          <circle
            v-for="(d, i) in emotionPayload"
            :key="i"
            :cx="emotionX(i, emotionPayload.length)"
            :cy="emotionY(d.emotion)"
            r="2.5"
            class="ap-emotion-dot"
            :class="d.emotion >= 0 ? 'pos' : 'neg'"
          />
        </svg>
        <div class="ap-emotion-legend">
          <span v-for="(d, i) in emotionPayload" :key="i" class="ap-emotion-seg">
            <span class="ap-emotion-label">{{ d.label }}</span>
            <span class="ap-emotion-val">{{ d.emotion > 0 ? '+' : '' }}{{ d.emotion }}</span>
          </span>
        </div>
      </div>
      <EmptyState v-else :icon="Activity" size="compact" text="情绪曲线样本不足。" />
      <!-- 节奏上下文（读 rhythm chapterDiff 当前章：字数目标/实际 + 钩子/情绪偏差） -->
      <div v-if="showRhythm && rhythmRow" class="ap-emotion-rhythm">
        <Gauge :size="12" />
        <span class="ap-rhythm-label">节奏</span>
        <span>字数 {{ rhythmRow.字数 ?? '—' }}</span>
        <span v-if="rhythmRow.钩子类型偏差" class="ap-rhythm-warn">钩子偏差</span>
        <span v-if="rhythmRow.情绪定位偏差" class="ap-rhythm-warn">情绪偏差</span>
      </div>
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
      <EmptyState v-if="aiOff && !hooksSlot.envelope" :icon="Anchor" size="compact" text="AI 不可达，暂无钩子分析。" />
      <EmptyState v-else-if="!hooksSlot.envelope" :icon="Anchor" size="compact" :text="`暂无钩子分析${aiOff ? '' : '，点「重新分析」生成'}。`" />
      <div v-else-if="hooksPayload && hooksPayload.hooks.length" class="ap-hooks-list">
        <div v-for="(h, i) in hooksPayload.hooks" :key="i" class="ap-hook">
          <div class="ap-hook-head">
            <span class="ap-hook-pos">{{ h.pos }}</span>
            <span class="ap-hook-type">{{ h.type }}</span>
            <span class="ap-hook-strength">
              <i v-for="d in 5" :key="d" class="ap-strength-dot" :class="{ on: d <= h.strength }" />
            </span>
          </div>
          <div v-if="h.note" class="ap-hook-note">{{ h.note }}</div>
        </div>
      </div>
      <EmptyState v-else :icon="Anchor" size="compact" text="未识别到明显钩子。" />
    </div>

    <!-- 文风总结卡（B4.4） -->
    <div class="ap-card">
      <div class="ap-card-head">
        <div class="ap-card-title"><Feather :size="14" /><span>文风总结</span></div>
        <button class="ap-run" :disabled="aiOff || analysis.loading === 'style'" @click="runKind('style')">
          <RefreshCw :size="12" :class="{ spin: analysis.loading === 'style' }" />
          <span>{{ analysis.loading === 'style' ? '分析中…' : '重新分析' }}</span>
        </button>
      </div>
      <EmptyState v-if="aiOff && !styleSlot.envelope" :icon="Feather" size="compact" text="AI 不可达，暂无文风总结。" />
      <EmptyState v-else-if="!styleSlot.envelope" :icon="Feather" size="compact" :text="`暂无文风总结${aiOff ? '' : '，点「重新分析」生成'}。`" />
      <div v-else-if="stylePayload" class="ap-style-body">
        <div class="ap-style-drift">{{ stylePayload.drift }}</div>
        <div v-if="stylePayload.口癖 && stylePayload.口癖.length" class="ap-style-tags">
          <span v-for="(t, i) in stylePayload.口癖" :key="i" class="ap-style-tag">{{ t }}</span>
        </div>
        <div v-if="stylePayload.重复度评价" class="ap-style-line">
          <span class="ap-style-line-label">重复度</span>{{ stylePayload.重复度评价 }}
        </div>
        <div v-if="stylePayload.建议 && stylePayload.建议.length" class="ap-style-suggestions">
          <div v-for="(s, i) in stylePayload.建议" :key="i" class="ap-style-suggestion">{{ s }}</div>
        </div>
      </div>
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
  font-size: var(--font-size-s);
  color: var(--text-faint);
}
.ap-stale {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  font-size: var(--font-size-xs);
  color: var(--dv-warn);
  background: color-mix(in srgb, var(--dv-warn) 8%, transparent);
  border: 1px solid color-mix(in srgb, var(--dv-warn) 20%, transparent);
  border-radius: var(--radius-s);
  padding: 6px 8px;
}
/* 章节标签 */
.ap-tags-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: var(--size-4-2) var(--size-4-3);
}
.ap-tag-cell {
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.ap-tag-label {
  font-size: var(--font-size-xs);
  color: var(--text-muted);
}
.ap-tag-val {
  font-size: var(--font-size-s);
  padding: 2px 10px;
  border-radius: var(--radius-s);
  color: var(--text-accent);
  background: color-mix(in srgb, var(--text-accent) 12%, transparent);
  align-self: flex-start;
}
.ap-tag-empty {
  font-size: var(--font-size-s);
  color: var(--text-faint);
}
.ap-card {
  border: 1px solid var(--background-modifier-border);
  border-radius: var(--radius-m);
  background: var(--background-primary);
  padding: var(--size-4-3);
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
  font-size: var(--font-size-s);
  font-weight: 600;
  color: var(--text-normal);
}
.ap-toggle {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  cursor: pointer;
  color: var(--text-faint);
}
.ap-toggle input {
  margin: 0;
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
  font-size: var(--font-size-xs);
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
  font-size: var(--font-size-m);
  color: var(--text-normal);
  line-height: 1.5;
}
.ap-gen {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  margin-top: 4px;
  font-size: var(--font-size-xs);
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
  font-size: var(--font-size-xs);
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
  transition: width var(--dur-slow) var(--ease-out);
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
  /* stroke 由 inline style 引用 #clw-emotion-grad 渐变（diverging 蓝→灰→橙）*/
  stroke-width: 1.5;
}
.ap-emotion-dot.pos {
  fill: var(--div-pos);
}
.ap-emotion-dot.neg {
  fill: var(--div-neg);
}
.ap-emotion-y {
  fill: var(--text-faint);
  font-size: var(--font-size-xxs);
  font-variant-numeric: tabular-nums;
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
  font-size: var(--font-size-xs);
  color: var(--text-muted);
}
.ap-emotion-label {
  color: var(--text-normal);
}
.ap-emotion-val {
  color: var(--text-faint);
  font-variant-numeric: tabular-nums;
}
.ap-emotion-rhythm {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: var(--size-4-2);
  padding: 5px 8px;
  background: var(--background-secondary);
  border-radius: var(--radius-s);
  font-size: var(--font-size-xs);
  color: var(--text-muted);
}
.ap-rhythm-label {
  color: var(--text-normal);
  font-weight: 600;
}
.ap-rhythm-warn {
  color: var(--text-error);
}
/* 钩子密度 */
.ap-density {
  font-size: var(--font-size-xs);
  padding: 1px 8px;
  border-radius: 10px;
  background: var(--background-modifier-border);
  color: var(--text-normal);
}
.density-密 {
  background: color-mix(in srgb, var(--dv-bad) 15%, transparent);
  color: var(--text-error);
}
.density-疏 {
  background: color-mix(in srgb, var(--dv-warn) 15%, transparent);
  color: var(--dv-warn);
}
.density-中 {
  background: color-mix(in srgb, var(--dv-good) 15%, transparent);
  color: var(--dv-good);
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
  font-size: var(--font-size-xs);
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
  font-size: var(--font-size-xxs);
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
  font-size: var(--font-size-xs);
  color: var(--text-muted);
  line-height: 1.5;
}
/* 文风总结 */
.ap-style-body {
  display: flex;
  flex-direction: column;
  gap: var(--size-4-2);
}
.ap-style-drift {
  font-size: var(--font-size-m);
  color: var(--text-normal);
  line-height: 1.5;
}
.ap-style-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}
.ap-style-tag {
  font-size: var(--font-size-xs);
  padding: 1px 8px;
  border-radius: 8px;
  background: color-mix(in srgb, var(--dv-warn) 12%, transparent);
  color: var(--dv-warn);
}
.ap-style-line {
  font-size: var(--font-size-s);
  color: var(--text-muted);
}
.ap-style-line-label {
  color: var(--text-faint);
  margin-right: 4px;
}
.ap-style-suggestions {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding-left: 8px;
  border-left: 2px solid var(--background-modifier-border);
}
.ap-style-suggestion {
  font-size: var(--font-size-s);
  color: var(--text-normal);
  line-height: 1.5;
}
</style>
