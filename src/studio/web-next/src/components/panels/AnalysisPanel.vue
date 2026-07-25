<script setup lang="ts">
// 分析面板（M12 块4 B4.0 骨架 + B4.1 体验分）：
// 读 score 信封存量 → 过期条 + 体验分（大数字/verdict/dims 进度条）+ 重新分析（aiOff 置灰）。
// emotion/hooks/style 占位卡（B4.2-B4.4 补渲染）。生成与展示解耦：AI 不可达时存量照常。
import { computed, watch } from 'vue'
import { Sparkles, RefreshCw, AlertCircle, Clock, Activity, Anchor, Feather } from 'lucide-vue-next'
import { useAnalysisStore } from '../../stores/analysis'
import { useWorkspaceStore } from '../../stores/workspace'
import { useTreeStore } from '../../stores/tree'
import { useUiStore } from '../../stores/ui'
import { formKindOf } from '../../shared/words'

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

interface ScorePayload {
  score: number
  verdict: string
  dims: { 爽点: number; 节奏感: number; 拖沓: number }
}
const slot = computed(() => analysis.byKind.score)
const scorePayload = computed(() => slot.value.envelope?.payload as ScorePayload | undefined)
const generatedLabel = computed(() => {
  const t = slot.value.envelope?.generatedAt
  if (!t) return ''
  return new Date(t).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
})

async function loadScore(): Promise<void> {
  if (docId.value && isReviewable.value) await analysis.load(props.bookName, docId.value, 'score')
}
watch(docId, () => {
  analysis.clear()
  void loadScore()
}, { immediate: true })

async function runScore(): Promise<void> {
  if (!docId.value) return
  await analysis.run(props.bookName, docId.value, 'score')
}

// dims 进度条配色：爽点/节奏感 高=好（绿）；拖沓 高=差（橙）
function dimColor(label: string): string {
  return label === '拖沓' ? 'var(--color-orange, #d97706)' : 'var(--color-green, #4e9d68)'
}
function dimWidth(label: string, v: number): string {
  // 拖沓反向：分越高条越短（差→短，视觉警示）；其余正向
  const pct = label === '拖沓' ? (10 - v) * 10 : v * 10
  return `${Math.max(0, Math.min(100, pct))}%`
}
</script>

<template>
  <section v-if="!isReviewable" class="ap-hint">分析仅适用于正文 / 草稿文档。</section>

  <section v-else class="analysis-panel">
    <!-- 过期条（正文变更 → 存量标过期） -->
    <div v-if="slot.envelope && slot.stale" class="ap-stale">
      <AlertCircle :size="13" />
      <span>正文已变更，体验分为旧版存量（可重新分析）。</span>
    </div>

    <!-- 体验分卡 -->
    <div class="ap-card">
      <div class="ap-card-head">
        <div class="ap-card-title">
          <Sparkles :size="14" />
          <span>体验分</span>
        </div>
        <button
          class="ap-run"
          :disabled="aiOff || analysis.loading === 'score'"
          :title="aiOff ? 'AI 不可达' : '重新分析'"
          @click="runScore"
        >
          <RefreshCw :size="12" :class="{ spin: analysis.loading === 'score' }" />
          <span>{{ analysis.loading === 'score' ? '分析中…' : '重新分析' }}</span>
        </button>
      </div>

      <div v-if="aiOff && !slot.envelope" class="ap-empty">AI 不可达，暂无体验分。可达后点「重新分析」生成。</div>

      <div v-else-if="analysis.error && analysis.loading === null" class="ap-error">
        <AlertCircle :size="13" />
        <span>{{ analysis.error }}</span>
      </div>

      <div v-else-if="!slot.envelope" class="ap-empty">
        暂无体验分{{ aiOff ? '' : '，点「重新分析」生成' }}。
      </div>

      <div v-else-if="scorePayload" class="ap-score-body">
        <div class="ap-score-row">
          <div class="ap-score-num">{{ scorePayload.score }}</div>
          <div class="ap-score-meta">
            <div class="ap-verdict">{{ scorePayload.verdict }}</div>
            <div v-if="generatedLabel" class="ap-gen">
              <Clock :size="11" />
              <span>{{ generatedLabel }} · {{ slot.envelope.model }}</span>
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
              <div
                class="ap-dim-fill"
                :style="{ width: dimWidth(String(k), Number(v)), background: dimColor(String(k)) }"
              />
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- 情绪曲线 / 钩子密度 / 文风总结 占位（B4.2-B4.4） -->
    <div class="ap-card ap-card--placeholder">
      <div class="ap-card-title"><Activity :size="14" /><span>情绪曲线</span></div>
      <div class="ap-placeholder">分段情绪 + 叠加节奏视图（M12 块4 B4.2）</div>
    </div>
    <div class="ap-card ap-card--placeholder">
      <div class="ap-card-title"><Anchor :size="14" /><span>钩子密度</span></div>
      <div class="ap-placeholder">规则版 + AI 识别评价（M12 块4 B4.3）</div>
    </div>
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
</style>
