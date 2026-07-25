<script setup lang="ts">
// 文档编辑视图（细案 T1.2）：inline 标题（章名，只读）+ CM6 正文 + 保存态指示 + 30s 自动保存。
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useDocStore } from '../stores/doc'
import { useTreeStore } from '../stores/tree'
import { useWorkspaceStore } from '../stores/workspace'
import { useUiStore } from '../stores/ui'
import { updateChapterMetaDoc } from '../api/documents'
import { stripFrontmatter, mergeFm, parseFmFields, formKindOf } from '../shared/words'
import CmHost from '../editor/CmHost.vue'

const props = defineProps<{ docId: string | null }>()
const doc = useDocStore()
const tree = useTreeStore()
const ws = useWorkspaceStore()
const ui = useUiStore()
const cmHost = ref<{ insertText: (t: string) => void; getSelection: () => string } | null>(null)

// 右栏速查「插入」命令管道：pendingInsert 变 → 插入光标 + 清空（无编辑器也清空，避免残留）
watch(
  () => ws.pendingInsert,
  (text) => {
    if (!text) return
    if (cmHost.value) cmHost.value.insertText(text)
    ws.consumeInsert()
  },
)

const entry = computed(() => (props.docId ? doc.get(props.docId) : undefined))

// 编辑区只显 body（剥离 fm）：仅对有右栏表单的文档剥离（fm 走表单管理）；
// 六类账本/草稿等无表单文档显全文（剥离了 fm 也无处编辑，反而锁死）。
const hasForm = computed(() => (entry.value ? formKindOf(entry.value.path) !== null : false))
const body = computed(() => {
  const c = entry.value?.content ?? ''
  return hasForm.value ? stripFrontmatter(c).replace(/^\n+/, '') : c
})
function onBodyChange(next: string): void {
  const e = entry.value
  if (!e) return
  // 有表单：fm 不在编辑区 → mergeFm 拼回（保留 fm 头，只换 body）；无表单：原样 patch 全文
  doc.patch(e.docId, hasForm.value ? mergeFm(e.content, next) : next)
}

// 顶部标题：仅 chapter 可编辑，绑 fm 标题 → 失焦/回车写 fm 标题 + 联动 rename 文件名。
const isChapter = computed(() => entry.value?.path.startsWith('定稿/正文/') ?? false)
const titleModel = ref('')
watch(
  () => entry.value?.content,
  (c) => {
    const e = entry.value
    titleModel.value = e ? (parseFmFields(c ?? '').标题 ?? e.name) : ''
  },
  { immediate: true },
)
const titleSaving = ref(false)
async function onTitleCommit(): Promise<void> {
  const e = entry.value
  if (!e || !ws.activeDocId || titleSaving.value) return
  const newTitle = titleModel.value.trim() || '未命名'
  const current = parseFmFields(e.content).标题 ?? e.name
  if (newTitle === current) return
  titleSaving.value = true
  try {
    // 标题联动 rename（文件名 + fm 标题）；保护本地未存 body：记 body → 写后 refresh 拼回
    const localBody = stripFrontmatter(e.content)
    await updateChapterMetaDoc(doc.bookName!, ws.activeDocId, { 标题: newTitle })
    await tree.load(doc.bookName!)
    const fresh = tree.byDocId.get(ws.activeDocId)
    if (fresh) {
      e.path = fresh.path
      e.name = fresh.name
    }
    await doc.refresh(ws.activeDocId)
    const refreshed = doc.get(ws.activeDocId)
    if (refreshed && stripFrontmatter(refreshed.content) !== localBody) {
      doc.patch(ws.activeDocId, mergeFm(refreshed.content, localBody))
    }
  } catch (err) {
    ui.toast(err instanceof Error ? err.message : String(err), 'error')
  } finally {
    titleSaving.value = false
  }
}

// 持久化恢复缺口：刷新后 tabs 恢复但 doc Map 空 → 活动 tab 无 entry → 自动 open。
// 正常切 tab 不触发（entry 已在 Map，dirty 驻留不丢，决策 R6）。
watch(
  () => props.docId,
  async (id) => {
    if (id && !doc.get(id)) {
      const node = tree.byDocId.get(id)
      if (node) {
        try {
          await doc.open(node)
        } catch {
          /* 打开失败静默（tab 仍在，点别的即可） */
        }
      }
    }
  },
  { immediate: true },
)

// 30s 自动保存（origin='autosave'）：仅当前活动文档 dirty 时触发（细案 §7 数值）。
let timer: ReturnType<typeof setInterval> | null = null
function tick(): void {
  if (entry.value?.dirty && !entry.value.saving) {
    void doc.save(entry.value.docId, 'autosave')
  }
}
onMounted(() => {
  timer = setInterval(tick, 30_000)
  // 注册选区读取器（选段改写经 ws 读 cmHost.getSelection）
  ws.setEditorGetSelection(() => cmHost.value?.getSelection() ?? '')
})
onUnmounted(() => {
  if (timer) clearInterval(timer)
  ws.setEditorGetSelection(null)
})
</script>

<template>
  <div v-if="!entry" class="editor-empty">选择左侧章节开始写作</div>
  <div v-else class="editor-view">
    <header class="doc-head">
      <input
        v-if="isChapter"
        v-model="titleModel"
        class="inline-title editable"
        placeholder="未命名"
        @blur="onTitleCommit"
        @keydown.enter.prevent="onTitleCommit"
      />
      <input v-else class="inline-title" :value="entry.name" readonly placeholder="未命名" />
      <span
        class="save-state"
        :class="{ dirty: entry.dirty, saving: entry.saving, err: !!entry.error }"
      >
        {{
          entry.saving
            ? '保存中…'
            : entry.error
              ? entry.error
              : entry.dirty
                ? '未保存（⌘S）'
                : entry.savedAt
                  ? '已保存'
                  : ''
        }}
      </span>
      <!-- 乐观锁冲突出路：重载（丢本地）/ 覆盖（丢远端），二选一解除冲突态 -->
      <template v-if="entry.conflict">
        <button class="conflict-btn" @click="doc.reloadFromRemote(entry.docId)">重载远端</button>
        <button class="conflict-btn danger" @click="doc.overwriteRemote(entry.docId)">
          覆盖远端
        </button>
      </template>
    </header>
    <div class="doc-body">
      <CmHost
        ref="cmHost"
        :model-value="body"
        :mode="entry.mode"
        :typewriter="ws.focusMode"
        @update:model-value="onBodyChange"
      />
    </div>
  </div>
</template>

<style scoped>
.editor-empty {
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-faint);
  font-size: 14px;
}
.editor-view {
  height: 100%;
  display: flex;
  flex-direction: column;
}
.doc-head {
  flex-shrink: 0;
  display: flex;
  align-items: baseline;
  gap: var(--size-4-3);
  padding: var(--size-4-4) var(--size-4-6) var(--size-4-2);
  border-bottom: 1px solid var(--background-modifier-border);
}
.inline-title {
  flex: 1;
  border: none;
  outline: none;
  background: transparent;
  font-size: 22px;
  font-weight: 700;
  color: var(--text-normal);
  font-family: var(--font-ui);
}
/* chapter 可编辑标题：hover 有底色提示可点；内边距补偿保持视觉对齐 */
.inline-title.editable {
  cursor: text;
  border-radius: var(--radius-s);
  padding: 2px 6px;
  margin: -2px -6px;
  transition: background 0.12s;
}
.inline-title.editable:hover {
  background: var(--background-modifier-hover);
}
.save-state {
  flex-shrink: 0;
  font-size: 12px;
  color: var(--text-faint);
}
.save-state.dirty {
  color: var(--text-warning);
}
.save-state.saving {
  color: var(--text-muted);
}
.save-state.err {
  color: var(--text-error);
}
.conflict-btn {
  flex-shrink: 0;
  font-size: 12px;
  padding: 1px 8px;
  border: 1px solid var(--background-modifier-border);
  border-radius: var(--radius-s);
  background: var(--background-secondary);
  color: var(--text-muted);
  cursor: pointer;
}
.conflict-btn:hover {
  background: var(--background-modifier-hover);
  color: var(--text-normal);
}
.conflict-btn.danger:hover {
  color: var(--text-error);
}
.doc-body {
  flex: 1;
  min-height: 0;
  padding: var(--size-4-4) var(--size-4-6);
  overflow: hidden;
}
</style>
