<script setup lang="ts">
// 本章历史（单章版本回滚）：列 .snapshots 版本 → 选中恢复。
// 恢复走 origin='restore'，服务端会先把当前内容留一份底——恢复本身可再撤销。
import { ref, computed, watch } from 'vue'
import { RotateCcw, Clock, AlertCircle } from 'lucide-vue-next'
import { useDocStore } from '../../stores/doc'
import { useWorkspaceStore } from '../../stores/workspace'
import { useUiStore } from '../../stores/ui'
import { listSnapshots, restoreSnapshot, type SnapshotEntry } from '../../api/snapshots'
import { countWords, stripFrontmatter } from '../../shared/words'
import { friendlyError } from '../../shared/error'

const props = defineProps<{ bookName: string }>()
const doc = useDocStore()
const ws = useWorkspaceStore()
const ui = useUiStore()

const entries = ref<SnapshotEntry[]>([])
const loading = ref(false)
const err = ref<string | null>(null)
const restoring = ref<string | null>(null)

const current = computed(() => (ws.activeDocId ? doc.get(ws.activeDocId) : undefined))
const currentWords = computed(() =>
  current.value ? countWords(stripFrontmatter(current.value.content)) : 0,
)

/** 来源人话（origin 是机器值，界面不露）。 */
const ORIGIN_LABEL: Record<string, string> = {
  autosave: '自动保存前',
  manual: '保存前',
  restore: '恢复前',
  'external-merge': '外部修改合并前',
  finalize: '定稿',
}

/** 时间人话：今天只给时分，昨天带「昨天」，更早给月日。 */
function fmtTime(ms: number): string {
  const d = new Date(ms)
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  const today = new Date()
  const sameDay = (a: Date, b: Date) => a.toDateString() === b.toDateString()
  if (sameDay(d, today)) return hm
  const yesterday = new Date(today.getTime() - 86_400_000)
  if (sameDay(d, yesterday)) return `昨天 ${hm}`
  return `${d.getMonth() + 1}-${d.getDate()} ${hm}`
}

/** 与当前正文的字数差（+ 表示当时比现在多）。 */
function delta(words: number): string {
  const d = words - currentWords.value
  if (d === 0) return ''
  return d > 0 ? `+${d}` : String(d)
}

async function load(): Promise<void> {
  if (!ws.activeDocId) {
    entries.value = []
    return
  }
  loading.value = true
  err.value = null
  try {
    entries.value = await listSnapshots(props.bookName, ws.activeDocId)
  } catch (e) {
    const msg = friendlyError(e)
    err.value = msg === 'not found' ? '暂无历史数据' : msg
  } finally {
    loading.value = false
  }
}

watch(() => [ws.activeDocId, props.bookName], load, { immediate: true })
// 保存后版本会变，刷新列表（savedAt 变化即一次落盘）
watch(() => current.value?.savedAt, load)

async function onRestore(e: SnapshotEntry): Promise<void> {
  const docId = ws.activeDocId
  const cur = current.value
  if (!docId || !cur || restoring.value) return
  const ok = await ui.ask({
    title: `恢复到 ${fmtTime(e.time)} 的版本`,
    message: `当前正文将被这个版本覆盖。当前内容会自动留一份底，恢复后仍可退回。`,
    confirmText: '恢复',
    danger: true,
  })
  if (!ok) return
  restoring.value = e.id
  try {
    await restoreSnapshot(props.bookName, docId, e.id, cur.baselineRevision)
    await doc.refresh(docId)
    ui.toast(`已恢复到 ${fmtTime(e.time)} 的版本`, 'success')
    await load()
  } catch (error) {
    ui.toast(friendlyError(error), 'error')
  } finally {
    restoring.value = null
  }
}
</script>

<template>
  <div class="history-panel">
    <div v-if="!ws.activeDocId" class="empty-state">
      <Clock :size="20" />
      <span>未打开文档</span>
    </div>
    <div v-else-if="loading && !entries.length" class="empty-state">
      <Clock :size="20" />
      <span>读取中…</span>
    </div>
    <div v-else-if="err" class="empty-state err">
      <AlertCircle :size="20" />
      <span>{{ err }}</span>
    </div>
    <div v-else-if="!entries.length" class="empty-state">
      <Clock :size="20" />
      <span>暂无历史版本</span>
      <span class="empty-sub">保存过几次之后才会生成历史版本</span>
    </div>
    <template v-else>
      <div class="row current">
        <span class="time">当前</span>
        <span class="words">{{ currentWords.toLocaleString() }} 字</span>
      </div>
      <div v-for="e in entries" :key="e.id" class="row">
        <div class="meta">
          <span class="time">{{ fmtTime(e.time) }}</span>
          <span class="origin">{{ ORIGIN_LABEL[e.origin] ?? e.origin }}</span>
          <span v-if="e.pinned" class="pinned-badge">里程碑</span>
        </div>
        <div class="right">
          <span class="words">
            {{ e.words.toLocaleString() }}
            <span v-if="delta(e.words)" class="delta">{{ delta(e.words) }}</span>
          </span>
          <button
            class="restore-btn"
            :disabled="restoring !== null"
            :data-tip="`恢复到 ${fmtTime(e.time)}`"
            @click="onRestore(e)"
          >
            <RotateCcw :size="13" />
          </button>
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.history-panel {
  border: 1px solid var(--background-modifier-border);
  border-radius: var(--radius-m);
  background: var(--background-primary);
  padding: var(--size-4-3);
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--size-4-2);
  padding: var(--size-4-4) var(--size-4-2);
  color: var(--text-faint);
  font-size: var(--font-size-s);
  text-align: center;
}
.empty-state.err {
  color: var(--text-error);
}
.empty-sub {
  font-size: var(--font-size-xs);
  color: var(--text-faint);
}
.row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--size-4-2);
  padding: 4px 6px;
  border-radius: var(--radius-s);
  font-size: var(--font-size-s);
}
.row:hover {
  background: var(--background-modifier-hover);
}
.row.current {
  color: var(--text-normal);
  font-weight: 600;
}
.meta {
  display: flex;
  align-items: baseline;
  gap: var(--size-4-2);
  min-width: 0;
}
.time {
  color: var(--text-normal);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.origin {
  font-size: var(--font-size-xs);
  color: var(--text-faint);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
/* 定稿里程碑标记（pinned 版本，永久保留） */
.pinned-badge {
  font-size: var(--font-size-xs);
  color: var(--text-accent);
  border: 1px solid var(--text-accent);
  border-radius: var(--radius-s);
  padding: 0 4px;
  white-space: nowrap;
  flex-shrink: 0;
}
.right {
  display: flex;
  align-items: center;
  gap: var(--size-4-2);
  flex-shrink: 0;
}
.words {
  color: var(--text-muted);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.delta {
  color: var(--text-faint);
  font-size: var(--font-size-xs);
  margin-left: 2px;
}
/* 恢复按钮：默认淡，hover 行时显形 */
.restore-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  border: none;
  border-radius: var(--radius-s);
  background: transparent;
  color: var(--text-faint);
  cursor: pointer;
  opacity: 0;
  transition: opacity var(--dur-fast) var(--ease-out), color var(--dur-fast) var(--ease-out);
}
.row:hover .restore-btn {
  opacity: 1;
}
.restore-btn:hover {
  color: var(--text-accent);
  background: var(--background-modifier-hover);
}
.restore-btn:disabled {
  cursor: default;
  opacity: 0.4;
}
</style>
