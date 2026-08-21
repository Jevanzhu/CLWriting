<script setup lang="ts">
// 分析面板（右栏速览）：全书速览（聚合趋势摘要）。
// 章节标签已回归 MetaFormPanel（章节信息）；单章分析详情在 rhythm 视图。
import { computed, ref, watch } from 'vue'
import { RefreshCw, Tag, Sparkles } from 'lucide-vue-next'
import { useWorkspaceStore } from '../../stores/workspace'
import { useTreeStore } from '../../stores/tree'
import { useDocStore } from '../../stores/doc'
import { useUiStore } from '../../stores/ui'
import { formKindOf, parseFmFields, isBodyKind, stripFrontmatter, mergeFm } from '../../shared/words'
import { getAnalysisOverview, autotag, inferMeta, type AnalysisOverview } from '../../api/analysis'
import { updateDocMeta } from '../../api/documents'
import { friendlyError } from '../../shared/error'

const props = defineProps<{ bookName: string }>()
const ws = useWorkspaceStore()
const tree = useTreeStore()
const ui = useUiStore()
const doc = useDocStore()

const docId = computed(() => ws.activeDocId)
const entry = computed(() => (docId.value ? doc.get(docId.value) : undefined))
const node = computed(() => (docId.value ? tree.byDocId.get(docId.value) : undefined))
const isReviewable = computed(() => {
  if (!node.value) return false
  return isBodyKind(node.value.path)
})

// ── 章节标签分析（AI → fm；展示在 MetaFormPanel 章节信息）──
const tagging = ref(false)
async function analyzeTags(): Promise<void> {
  if (!docId.value || tagging.value) return
  // dd-P1：入口捕获 docId——await（AI 调用可达 60s）后 docId.value 可能已切到别的文档，
  // 届时用新 id 写回 = 把 A 的标签写进 B 的 fm、把 A 的正文 patch 进 B（dirty → 落盘覆盖）
  // 第五轮：bookName 同步捕获——props.bookName 在首个 await 后才求值，60s 内切书时
  // 请求变为 updateDocMeta(B 书, A 的 docId)，legacy 反查命中 B 书同路径文件时跨书写坏
  const id = docId.value
  const book = props.bookName
  tagging.value = true
  try {
    // 保护编辑区未保存的 body：记本地 body → 写 fm → refresh 拉磁盘 → 本地 body 拼回（与 MetaFormPanel.onSave 同口径）
    const localBody = entry.value ? stripFrontmatter(entry.value.content) : ''
    const tags = await autotag(book, id)
    await updateDocMeta(book, id, tags)
    // M-6（第八轮）：守卫补书名项（对齐 MetaFormPanel.onSave 双条件）——legacy docId
    // 纯路径派生跨书同路径，只查 docId 时 B 书同路径条目会被 A 书正文 patch → autosave 覆盖
    if (docId.value !== id || props.bookName !== book) return
    await doc.refresh(id)
    const refreshed = doc.get(id)
    if (refreshed && localBody && stripFrontmatter(refreshed.content) !== localBody) {
      doc.patch(id, mergeFm(refreshed.content, localBody))
    }
    ui.toast('标签分析完成', 'success')
  } catch (err) {
    ui.toast(friendlyError(err), 'error')
  } finally {
    tagging.value = false
  }
}

/** 章节标签字段（AI 判定 → fm；此处展示 + 章节信息也展示）。 */
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

// ── 目标情绪/核心反转（AI 从正文反推 → 写 fm；长短篇通用）──
const META_FIELDS = [
  { key: '目标情绪', label: '目标情绪' },
  { key: '核心反转', label: '核心反转' },
] as const
const metaValues = computed<Record<string, string>>(() => {
  if (!entry.value) return {}
  const parsed = parseFmFields(entry.value.content)
  const out: Record<string, string> = {}
  for (const f of META_FIELDS) out[f.key] = parsed[f.key] ?? ''
  return out
})
const inferring = ref(false)
async function inferChapterMeta(): Promise<void> {
  if (!docId.value || inferring.value) return
  // dd-P1：入口捕获 docId（同 analyzeTags——await 后切档会把 A 的推断写进 B）
  const id = docId.value
  inferring.value = true
  try {
    // 保护编辑区未保存的 body：记本地 body → 写 fm → refresh 拉磁盘 → 本地 body 拼回
    // 第五轮：bookName 入口捕获（同 analyzeTags 的跨书写坏面）
    const localBody = entry.value ? stripFrontmatter(entry.value.content) : ''
    const book = props.bookName
    const meta = await inferMeta(book, id)
    await updateDocMeta(book, id, meta)
    // M-6（第八轮）：同上——双条件守卫
    if (docId.value !== id || props.bookName !== book) return
    await doc.refresh(id)
    const refreshed = doc.get(id)
    if (refreshed && localBody && stripFrontmatter(refreshed.content) !== localBody) {
      doc.patch(id, mergeFm(refreshed.content, localBody))
    }
    ui.toast('情绪/反转推断完成', 'success')
  } catch (err) {
    ui.toast(friendlyError(err), 'error')
  } finally {
    inferring.value = false
  }
}

// ── 全书速览（聚合 overview 摘要）──
const overview = ref<AnalysisOverview | null>(null)
// M-11：代守卫——快速切书 A→B 时 A 的慢响应不覆盖 B 的速览（含失败回填 null）
let overviewGen = 0
async function loadOverview(): Promise<void> {
  const gen = ++overviewGen
  try {
    const r = await getAnalysisOverview(props.bookName)
    if (gen !== overviewGen) return
    overview.value = r
  } catch {
    if (gen !== overviewGen) return
    overview.value = null
  }
}
watch(() => props.bookName, () => void loadOverview(), { immediate: true })

// 体验分均值 + 趋势（后 3 章均值 vs 前 3 章均值 → ↑/↓/→）
const scoreAvg = computed(() => {
  const t = overview.value?.scoreTrend ?? []
  if (!t.length) return null
  return t.reduce((s, p) => s + p.score, 0) / t.length
})
const scoreTrend = computed(() => {
  const t = overview.value?.scoreTrend ?? []
  if (t.length < 4) return '→'
  const front = t.slice(0, 3).reduce((s, p) => s + p.score, 0) / 3
  const back = t.slice(-3).reduce((s, p) => s + p.score, 0) / 3
  if (back > front + 0.5) return '↑'
  if (back < front - 0.5) return '↓'
  return '→'
})
const analyzedCount = computed(() => overview.value?.scoreTrend.length ?? 0)
const totalChapters = computed(() => overview.value?.allChapters.length ?? 0)

const styleDrift = computed(() => overview.value?.style?.drift ?? null)
const hooksCoverage = computed(() => {
  const t = overview.value?.hooksTrend ?? []
  const total = overview.value?.allChapters.length ?? 0
  if (!total) return null
  return `${t.length}/${total}`
})

function gotoOverview(): void {
  ws.setActiveView('overview')
}
</script>

<template>
  <section v-if="!isReviewable" class="ap-hint">分析仅适用于正文 / 草稿文档。</section>
  <section v-else class="analysis-panel">
    <!-- 章节标签卡（AI 判定：钩子/情绪/场景） -->
    <div class="ap-card">
      <div class="ap-card-head">
        <div class="ap-card-title"><Tag :size="14" /><span>章节标签</span></div>
        <button class="ap-run" :disabled="tagging" @click="analyzeTags">
          <RefreshCw :size="12" :class="{ spin: tagging }" />
          <span>{{ tagging ? '分析中…' : '分析标签' }}</span>
        </button>
      </div>
      <div class="ap-tags-grid">
        <div v-for="f in TAG_FIELDS" :key="f.key" class="ap-tag-cell">
          <span class="ap-tag-label">{{ f.label }}</span>
          <span v-if="tagValues[f.key]" class="ap-tag-val">{{ tagValues[f.key] }}</span>
          <span v-else class="ap-tag-empty">—</span>
        </div>
      </div>
    </div>

    <!-- 情绪/反转卡（AI 读正文反推 → 写 fm；长短篇通用） -->
    <div class="ap-card">
      <div class="ap-card-head">
        <div class="ap-card-title"><Sparkles :size="14" /><span>情绪/反转</span></div>
        <button class="ap-run" :disabled="inferring" @click="inferChapterMeta">
          <RefreshCw :size="12" :class="{ spin: inferring }" />
          <span>{{ inferring ? '推断中…' : 'AI 推断' }}</span>
        </button>
      </div>
      <div class="ap-meta-list">
        <div v-for="f in META_FIELDS" :key="f.key" class="ap-meta-row">
          <span class="ap-meta-label">{{ f.label }}</span>
          <span v-if="metaValues[f.key]" class="ap-meta-val">{{ metaValues[f.key] }}</span>
          <span v-else class="ap-meta-empty">—</span>
        </div>
      </div>
    </div>
    <div class="ap-card">
      <div class="ap-card-head">
        <div class="ap-card-title"><span>全书速览</span></div>
        <button class="ap-ov-link" @click="gotoOverview">详情 →</button>
      </div>
      <div class="ap-ov-row">
        <span class="ap-ov-label">体验分</span>
        <span v-if="scoreAvg != null" class="ap-ov-val">
          {{ scoreAvg.toFixed(1) }}
          <span class="ap-ov-trend">{{ scoreTrend }}</span>
          <span class="ap-ov-sub">{{ analyzedCount }}/{{ totalChapters }} 章</span>
        </span>
        <span v-else class="ap-ov-empty">—</span>
      </div>
      <div class="ap-ov-row">
        <span class="ap-ov-label">文风</span>
        <span v-if="styleDrift" class="ap-ov-val-text">{{ styleDrift }}</span>
        <span v-else class="ap-ov-empty">—</span>
      </div>
      <div class="ap-ov-row">
        <span class="ap-ov-label">钩子</span>
        <span v-if="hooksCoverage" class="ap-ov-val">覆盖 {{ hooksCoverage }} 章</span>
        <span v-else class="ap-ov-empty">—</span>
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
/* 情绪/反转 */
.ap-meta-list {
  display: flex;
  flex-direction: column;
  gap: var(--size-4-2);
}
.ap-meta-row {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.ap-meta-label {
  font-size: var(--font-size-xs);
  color: var(--text-muted);
}
.ap-meta-val {
  font-size: var(--font-size-s);
  color: var(--text-normal);
  line-height: 1.4;
}
.ap-meta-empty {
  font-size: var(--font-size-s);
  color: var(--text-faint);
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
.spin {
  animation: ap-spin 0.9s linear infinite;
}
@keyframes ap-spin {
  to {
    transform: rotate(360deg);
  }
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
.ap-card-title {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: var(--font-size-s);
  font-weight: 600;
  color: var(--text-normal);
}
.ap-ov-link {
  border: none;
  background: transparent;
  font-size: var(--font-size-xs);
  color: var(--text-faint);
  cursor: pointer;
  transition: color var(--dur-fast) var(--ease-out);
}
.ap-ov-link:hover {
  color: var(--text-accent);
}
.ap-ov-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-size: var(--font-size-s);
  padding: 3px 0;
}
.ap-ov-label {
  color: var(--text-muted);
}
.ap-ov-val {
  color: var(--text-normal);
  font-variant-numeric: tabular-nums;
}
.ap-ov-trend {
  margin-left: 4px;
  font-weight: 600;
}
.ap-ov-sub {
  margin-left: 6px;
  font-size: var(--font-size-xs);
  color: var(--text-faint);
}
.ap-ov-val-text {
  color: var(--text-normal);
  text-align: right;
  max-width: 180px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ap-ov-empty {
  color: var(--text-faint);
}
</style>
