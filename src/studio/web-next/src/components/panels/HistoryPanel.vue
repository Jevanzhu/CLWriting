<script setup lang="ts">
// 本章历史（单章版本回滚）：列 .snapshots 版本 → 选中恢复。
// 恢复走 origin='restore'，服务端会先把当前内容留一份底——恢复本身可再撤销。
import { ref, computed, watch } from 'vue'
import { RotateCcw, Clock, AlertCircle } from 'lucide-vue-next'
import { useDocStore } from '../../stores/doc'
import { useWorkspaceStore } from '../../stores/workspace'
import { useUiStore } from '../../stores/ui'
import { listSnapshots, restoreSnapshot, type SnapshotEntry } from '../../api/snapshots'
import { useDebouncedWordCount } from '../../composables/useDebouncedWordCount'
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
// R46-5（四十六轮）：当前字数 150ms 防抖（EditorView R39-20 同款；此前每击键全文
// 重算并经 delta() 联动快照列表渲染）
const { count: currentWords } = useDebouncedWordCount(() => current.value?.content, () => ws.activeDocId)

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

let loadGen = 0
async function load(): Promise<void> {
  // RB-FE-P2-6：双 watch（doc/book/savedAt）并发加载竞态——旧响应不覆盖新列表
  const gen = ++loadGen
  if (!ws.activeDocId) {
    entries.value = []
    return
  }
  loading.value = true
  err.value = null
  try {
    const list = await listSnapshots(props.bookName, ws.activeDocId)
    if (gen !== loadGen) return
    entries.value = list
  } catch (e) {
    if (gen !== loadGen) return
    const msg = friendlyError(e)
    err.value = msg === 'not found' ? '暂无历史数据' : msg
  } finally {
    if (gen === loadGen) loading.value = false
  }
}

// E-8（二十九轮）：原「[activeDocId, bookName] + savedAt」双 watch 合并为单 watch——
// 三元组一次订阅（文档/书切换或落盘 savedAt 变化都走这里），回调内逐位比对，值未
// 变化不重拉（避免同一次状态变更触发两次列表请求）；load 内 loadGen 防竞态保持
watch(
  () => [ws.activeDocId, props.bookName, current.value?.savedAt] as const,
  (cur, prev) => {
    if (prev && cur[0] === prev[0] && cur[1] === prev[1] && cur[2] === prev[2]) return
    void load()
  },
  { immediate: true },
)

async function onRestore(e: SnapshotEntry): Promise<void> {
  // 低级项（第六轮）：上下文入口捕获——确认弹窗 await 期间可切书/切文档，
  // await 后重读 props.bookName 会把恢复请求发到别的书（docId 是旧书的）
  const book = props.bookName
  const docId = ws.activeDocId
  const cur = current.value
  if (!docId || !cur || restoring.value) return
  // Y-9（第五十七轮）：dirty 先存后恢复——restore 后的 refresh 走 dirty 分支（fm 取
  // 服务端、正文保留本地），随后 autosave 会用本地旧正文把刚恢复的版本静默覆盖，toast
  // 却报「已恢复」。先落盘：本地编辑进磁盘与「恢复前」留底（确认弹窗的承诺），恢复真正
  // 生效；保存失败（冲突等）则中止恢复交作者决断。
  if (cur.dirty) {
    const saved = await doc.save(docId, 'manual')
    if (props.bookName !== book || ws.activeDocId !== docId) return
    // R43-4（四十三轮）：F8 契约性 false 复检——manual 保存在途时排队等落定，dirty 已清
    // 即返 false（内容实际已在盘），此前被误判「保存失败」错误中止恢复（对齐 R34D-22
    // rewrite.ts 同型调用点口径）；仅「false 且仍 dirty」才是真失败
    if (!saved && doc.get(docId)?.dirty) {
      ui.toast('有未保存的编辑且保存失败，请先处理（重载/覆盖）再恢复历史版本', 'error')
      return
    }
  }
  const ok = await ui.ask({
    title: `恢复到 ${fmtTime(e.time)} 的版本`,
    message: `当前正文将被这个版本覆盖。当前内容会自动留一份底，恢复后仍可退回。`,
    confirmText: '恢复',
    danger: true,
  })
  if (!ok) return
  if (props.bookName !== book || ws.activeDocId !== docId) return
  restoring.value = e.id
  try {
    await restoreSnapshot(book, docId, e.id, cur.baselineRevision)
    // R30-7（三十轮）：refresh 静默吞错（网络抖动时 best-effort 失败）——按返回值分流，
    // false = 恢复已落盘但编辑器未对齐（基线可能仍指旧版），warning 提示手动重载，
    // 不再假报成功（旧行为编辑器显旧正文、下次编辑撞 REVISION_CONFLICT 才暴露）。
    // 恢复期间已切文档时 refresh 未执行（既有门），保持成功口径不变。
    let refreshed = true
    if (ws.activeDocId === docId && props.bookName === book) refreshed = await doc.refresh(docId)
    if (props.bookName === book) {
      if (refreshed) ui.toast(`已恢复到 ${fmtTime(e.time)} 的版本`, 'success')
      else ui.toast(`已恢复到 ${fmtTime(e.time)} 的版本，但编辑器刷新失败，请手动重载该章`, 'warning')
    }
    await load()
  } catch (error) {
    // R66-30（十四轮）：失败路径补书名守卫——上方成功路径有 `props.bookName === book` 门，
    // catch 漏配：restoreSnapshot await 窗口切书后，A 书的恢复失败错误会 toast 在 B 书界面上
    if (props.bookName === book) ui.toast(friendlyError(error), 'error')
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
