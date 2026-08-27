<script setup lang="ts">
// 三审面板（M12 块1 B1.2）：发起三审 → 阻断/警告分组意见；存量信封 + 过期条；AI 不可达置灰。
// 意见点击定位 CodeMirror、进度 SSE、verdict 联动 → 切片3 增强。
import { computed, ref, watch } from 'vue'
import { FileSearch, RefreshCw, AlertCircle, AlertTriangle, CircleCheck, Clock } from 'lucide-vue-next'
import { useReviewStore } from '../../stores/review'
import { useWorkspaceStore } from '../../stores/workspace'
import { useTreeStore } from '../../stores/tree'
import { useUiStore } from '../../stores/ui'
import { isBodyKind } from '../../shared/words'
import { friendlyError } from '../../shared/error'
import BetaBadge from '../ui/BetaBadge.vue'
import type { ReviewIssueFE } from '../../api/review'

const props = defineProps<{ bookName: string }>()
const review = useReviewStore()
const ws = useWorkspaceStore()
const tree = useTreeStore()
const ui = useUiStore()

const docId = computed(() => ws.activeDocId)
const node = computed(() => (docId.value ? tree.byDocId.get(docId.value) : undefined))
const isReviewable = computed(() => {
  if (!node.value) return false
  return isBodyKind(node.value.path)
})
const aiOff = computed(() => ui.aiAvailable === false)

// 打开文档 → 读存量信封；切走 → 清空
watch(
  docId,
  async (id) => {
    if (id && isReviewable.value) await review.loadEnvelope(props.bookName, id)
    else review.clear()
  },
  { immediate: true },
)

const blockers = computed(() => review.collected?.normalized.blockers ?? [])
const warnings = computed(() => review.collected?.normalized.warnings ?? [])
// R63-4（十一轮）：passed 必须查采集是否成立——此前只看 normalized.passed（空判据），
// 采集失败（stale/缺视角/坏条目）被渲染成「三审通过，无阻断/警告」，作者按假通过
// 放行从未真正审校的内容（刷新/重启依旧，已随信封持久化）。后端已同步注入阻断级
// 「三审未完成」issue（新跑的 collected.blockers 可见原因），此处 ok/bad_entries
// 复检兜住修复前落盘的旧信封（normalized.passed 仍 true）。
const passed = computed(
  () =>
    review.collected?.ok === true &&
    (review.collected.bad_entries?.length ?? 0) === 0 &&
    review.collected.normalized.passed === true &&
    blockers.value.length + warnings.value.length === 0,
)

/** R63-4：采集失败的人话原因（横幅展示；后端注入的阻断 issue 走 blockers 分组渲染） */
const incompleteReason = computed(() => {
  const c = review.collected
  if (!c || c.ok) return ''
  const parts: string[] = []
  if (c.missing_lenses.length > 0) parts.push(`缺视角：${c.missing_lenses.map(lensLabel).join('、')}`)
  if ((c.bad_entries?.length ?? 0) > 0) parts.push(`损坏：${c.bad_entries!.map((e) => `${e.path}（${e.reason}）`).join('；')}`)
  return parts.join('；')
})

const LENS_LABEL: Record<string, string> = {
  reader: '读者审',
  editor: '编辑审',
  continuity: '设定校对',
  hook: '钩子审',
  emotion_peak: '情绪反转审',
  payoff: '设定收尾审',
}
function lensLabel(l: string): string {
  return LENS_LABEL[l] ?? l
}

async function runReview(): Promise<void> {
  if (!docId.value) return
  await review.run(props.bookName, docId.value)
}

// 作者裁决（B1.3 方案 A）：通过/驳回 落 review 信封 payload.verdict；aiOff 不置灰（作者决策非 AI）
const verdictBadgeClass = computed(() => {
  const v = review.verdict
  if (!v) return 'verdict-pending'
  return v.approved ? 'verdict-pass' : 'verdict-reject'
})
const verdictBadgeLabel = computed(() => {
  const v = review.verdict
  if (!v) return '待审'
  return v.approved ? '通过' : '驳回'
})
const verdictSaving = ref(false)
async function setVerdict(approved: boolean): Promise<void> {
  if (!docId.value || verdictSaving.value) return
  // R66-32（十四轮）：书名入口捕获 + 失败 toast 守卫——await 窗口切书后，
  // A 书的裁决失败错误会 toast 在 B 书界面上；树红点刷新也按发起时的书
  const book = props.bookName
  verdictSaving.value = true
  try {
    await review.setVerdict(book, docId.value, approved)
    // T9b：verdict 变化（驳回/通过）→ 刷新树红点
    void tree.loadIssues(book)
  } catch (e) {
    // RB-FE-P2-3：后端不可达时给出反馈（原先 unhandled rejection 只进 console，点击无响应）
    if (props.bookName === book) ui.toast(friendlyError(e), 'error')
  } finally {
    verdictSaving.value = false
  }
}

function severityClass(s: string): string {
  if (s === 'S1' || s === 'S2') return 'sev-high'
  return 'sev-low'
}
/** severity 人话（S1/S2→重点，其余→参考；内部编号不暴露给作者） */
function severityLabel(s: string): string {
  return s === 'S1' || s === 'S2' ? '重点' : '参考'
}
</script>

<template>
  <section class="review-panel">
    <div class="rev-head">
      <div class="rev-title-row">
        <FileSearch :size="14" />
        <span class="rev-title">三审 <BetaBadge /></span>
      </div>
      <button
        class="rev-run-btn"
        :disabled="!isReviewable || aiOff || review.loading"
        :data-tip="aiOff ? 'AI 不可达（断网），仅可查看存量' : ''"
        @click="runReview"
      >
        <RefreshCw :size="13" :class="{ spin: review.loading }" />
        <span>{{ review.loading ? '三审中…' : '三审' }}</span>
      </button>
    </div>

    <!-- 作者裁决（B1.3 方案 A）：通过/驳回 落 review 信封 payload.verdict；不改文档状态 -->
    <div v-if="isReviewable" class="rev-verdict">
      <span class="rev-verdict-badge" :class="verdictBadgeClass">{{ verdictBadgeLabel }}</span>
      <div class="rev-verdict-actions">
        <button
          class="rev-verdict-btn"
          :class="{ active: review.verdict?.approved === true }"
          :disabled="verdictSaving"
          @click="setVerdict(true)"
        >通过</button>
        <button
          class="rev-verdict-btn reject"
          :class="{ active: review.verdict?.approved === false }"
          :disabled="verdictSaving"
          @click="setVerdict(false)"
        >驳回</button>
      </div>
    </div>

    <div v-if="aiOff" class="rev-ai-off">
      <Clock :size="13" />
      <span>AI 不可达，按钮置灰（存量仍可查看）。</span>
    </div>

    <div v-if="!isReviewable" class="rev-hint">三审仅适用于正文 / 草稿文档。</div>

    <div v-else-if="review.error" class="rev-error">
      <AlertCircle :size="14" />
      <span>{{ review.error }}</span>
    </div>

    <template v-else-if="review.collected">
      <div v-if="review.stale" class="rev-stale">
        <Clock :size="13" />
        <span>正文已变更，结果可能过期——重新三审。</span>
      </div>

      <!-- R63-4：采集失败显式横幅——修复前 ok:false 的信封被渲染成「三审通过」 -->
      <div v-if="!review.collected.ok" class="rev-stale">
        <AlertCircle :size="13" />
        <span>三审未完成{{ incompleteReason ? '——' + incompleteReason : '' }}，结论不成立，请重跑三审。</span>
      </div>

      <div v-if="passed" class="rev-clean">
        <CircleCheck :size="16" />
        <span>三审通过，无阻断/警告</span>
      </div>

      <div v-if="blockers.length > 0" class="rev-group">
        <div class="group-label group-label--red">
          <AlertCircle :size="13" />
          <span>阻断项（{{ blockers.length }}）</span>
        </div>
        <div
          v-for="(it, i) in blockers"
          :key="'b' + i"
          class="rev-item rev-item--red"
        >
          <div class="item-head">
            <span class="item-sev" :class="severityClass(it.severity)">{{ severityLabel(it.severity) }}</span>
            <span class="item-lens">{{ lensLabel(it.lens) }}</span>
            <span v-if="it.location" class="item-loc">{{ it.location }}</span>
          </div>
          <div class="item-issue">{{ it.issue }}</div>
          <div v-if="it.evidence.length > 0" class="item-evidence">「{{ it.evidence.join('；') }}」</div>
          <div v-if="it.fix" class="item-fix">建议：{{ it.fix }}</div>
        </div>
      </div>

      <div v-if="warnings.length > 0" class="rev-group">
        <div class="group-label group-label--yellow">
          <AlertTriangle :size="13" />
          <span>警告项（{{ warnings.length }}）</span>
        </div>
        <div
          v-for="(it, i) in warnings"
          :key="'w' + i"
          class="rev-item rev-item--yellow"
        >
          <div class="item-head">
            <span class="item-sev" :class="severityClass(it.severity)">{{ severityLabel(it.severity) }}</span>
            <span class="item-lens">{{ lensLabel(it.lens) }}</span>
            <span v-if="it.location" class="item-loc">{{ it.location }}</span>
          </div>
          <div class="item-issue">{{ it.issue }}</div>
          <div v-if="it.evidence.length > 0" class="item-evidence">「{{ it.evidence.join('；') }}」</div>
          <div v-if="it.fix" class="item-fix">建议：{{ it.fix }}</div>
        </div>
      </div>
    </template>

    <div v-else-if="!review.loading" class="rev-hint">
      点击「三审」生成意见（读者审 / 编辑审 / 设定校对）。
    </div>
  </section>
</template>

<style scoped>
.review-panel {
  display: flex;
  flex-direction: column;
  gap: var(--size-4-3);
}
.rev-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.rev-title-row {
  display: inline-flex;
  align-items: center;
  gap: var(--size-4-1);
  color: var(--text-muted);
  font-size: var(--font-size-xs);
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
}
.rev-run-btn {
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
  transition: opacity var(--dur-fast) var(--ease-out);
}
.rev-run-btn:hover:not(:disabled) {
  opacity: 0.88;
}
.rev-run-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
.spin {
  animation: clw-spin 0.9s linear infinite;
}

.rev-hint,
.rev-error,
.rev-ai-off,
.rev-stale {
  font-size: var(--font-size-s);
  color: var(--text-faint);
  line-height: 1.6;
  display: flex;
  align-items: flex-start;
  gap: 6px;
}
.rev-error {
  color: var(--text-error);
}
.rev-stale {
  color: var(--text-warning);
}
.rev-verdict {
  display: flex;
  align-items: center;
  gap: var(--size-4-2);
  padding: 6px 8px;
  border: 1px solid var(--background-modifier-border);
  border-radius: var(--radius-s);
  background: var(--background-secondary);
}
.rev-verdict-badge {
  font-size: var(--font-size-xs);
  font-weight: 600;
  padding: 2px 10px;
  border-radius: 10px;
}
.verdict-pending {
  background: var(--background-modifier-border);
  color: var(--text-muted);
}
.verdict-pass {
  background: color-mix(in srgb, var(--text-success) 15%, transparent);
  color: var(--dv-good);
}
.verdict-reject {
  background: color-mix(in srgb, var(--text-error) 15%, transparent);
  color: var(--text-error);
}
.rev-verdict-actions {
  display: inline-flex;
  gap: 4px;
  margin-left: auto;
}
.rev-verdict-btn {
  padding: 2px 10px;
  border: 1px solid var(--background-modifier-border);
  border-radius: var(--radius-s);
  background: var(--background-primary);
  color: var(--text-muted);
  font-size: var(--font-size-xs);
  cursor: pointer;
}
.rev-verdict-btn:hover {
  color: var(--text-normal);
}
.rev-verdict-btn.active {
  background: var(--dv-good);
  color: var(--text-on-accent, #fff);
  border-color: var(--dv-good);
}
.rev-verdict-btn.reject.active {
  background: var(--text-error);
  border-color: var(--text-error);
}
.rev-clean {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: var(--font-size-s);
  color: var(--dv-good);
}
.rev-group {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.group-label {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: var(--font-size-xs);
  font-weight: 600;
}
.group-label--red {
  color: var(--text-error);
}
.group-label--yellow {
  color: var(--text-warning);
}
.rev-item {
  padding: 6px 8px;
  border-radius: var(--radius-s);
  font-size: var(--font-size-s);
  line-height: 1.5;
}
.rev-item--red {
  background: color-mix(in srgb, var(--text-error) 8%, transparent);
  border-left: 2px solid var(--text-error);
}
.rev-item--yellow {
  background: color-mix(in srgb, var(--text-warning) 8%, transparent);
  border-left: 2px solid var(--text-warning);
}
.item-head {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 3px;
  flex-wrap: wrap;
}
.item-sev {
  font-size: var(--font-size-xxs);
  font-weight: 700;
  padding: 1px 4px;
  border-radius: var(--radius-s);
}
.sev-high {
  background: var(--text-error);
  color: var(--text-on-accent, #fff);
}
.sev-low {
  background: var(--background-modifier-hover);
  color: var(--text-muted);
}
.item-lens {
  font-size: var(--font-size-xxs);
  color: var(--text-faint);
}
.item-loc {
  font-size: var(--font-size-xxs);
  color: var(--text-faint);
  font-style: italic;
}
.item-issue {
  color: var(--text-normal);
}
.item-evidence {
  margin-top: 2px;
  font-size: var(--font-size-xs);
  color: var(--text-muted);
}
.item-fix {
  margin-top: 2px;
  font-size: var(--font-size-xs);
  color: var(--text-faint);
}
</style>
