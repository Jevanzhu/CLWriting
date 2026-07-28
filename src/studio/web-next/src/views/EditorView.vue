<script setup lang="ts">
// 文档编辑视图（细案 T1.2）：inline 标题（章名，只读）+ CM6 正文 + 保存态指示 + 30s 自动保存。
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { PenLine, Expand, Minimize2, Feather, CornerDownRight, Loader2 } from 'lucide-vue-next'
import { useDocStore } from '../stores/doc'
import { useTreeStore } from '../stores/tree'
import { useWorkspaceStore } from '../stores/workspace'
import { useUiStore } from '../stores/ui'
import { useRewriteStore } from '../stores/rewrite'
import { updateChapterMetaDoc } from '../api/documents'
import { stripFrontmatter, mergeFm, parseFmFields, formKindOf } from '../shared/words'
import CmHost from '../editor/CmHost.vue'
import EmptyState from '../components/ui/EmptyState.vue'

const props = defineProps<{ docId: string | null }>()
const doc = useDocStore()
const tree = useTreeStore()
const ws = useWorkspaceStore()
const ui = useUiStore()
const rewrite = useRewriteStore()

const aiOff = computed(() => ui.aiAvailable === false)
// AI 工具栏：对所有有分类的文档（正文/大纲/设定）+ 草稿显示
const isReviewable = computed(() => {
  if (!entry.value) return false
  if (formKindOf(entry.value.path) !== null) return true
  return /^工作区\/草稿-\d+\.md$/.test(entry.value.path)
})

// 面包屑：文档路径到父目录（末级=文件名=标题，不重复）
const crumbs = computed(() => {
  const p = entry.value?.path ?? ''
  return p.replace(/\.md$/, '').split('/').slice(0, -1).filter(Boolean)
})

// 保存状态（药丸 + 圆点指示器）
const saveStatus = computed<{ text: string; cls: string }>(() => {
  const e = entry.value
  if (!e) return { text: '', cls: '' }
  if (e.saving) return { text: '保存中', cls: 'saving' }
  if (e.handLocked) return { text: '手写中', cls: 'saving' }
  if (e.error) return { text: '保存失败', cls: 'err' }
  if (e.dirty) return { text: '未保存', cls: 'dirty' }
  if (e.savedAt) return { text: '已保存', cls: 'saved' }
  return { text: '', cls: '' }
})

// AI 预设动作：选中文字 → 一键改写 → 右栏 diff 预览
const aiActions = [
  { key: 'expand', label: '扩写', icon: Expand, instruction: '扩写选中段落，增加场景细节、感官描写和角色心理活动' },
  { key: 'condense', label: '缩写', icon: Minimize2, instruction: '压缩选中段落，去掉冗余对话和描写，保留核心信息和情节走向' },
  { key: 'polish', label: '润色', icon: Feather, instruction: '润色选中段落的文风和用词，提升文学性，不改变情节走向' },
  { key: 'continue', label: '续写', icon: CornerDownRight, instruction: '保留原文不变，在后面续写200-500字，延续当前风格和情节' },
] as const

async function runAiAssist(instruction: string): Promise<void> {
  const sel = ws.editorGetSelection?.() ?? ''
  if (!sel) {
    ui.toast('请先选中要操作的文字', 'info')
    return
  }
  if (!ws.activeDocId || !doc.bookName) return
  ws.setRightTab('review')
  await rewrite.run(doc.bookName, ws.activeDocId, instruction, sel)
}
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
  <EmptyState v-if="!entry" :icon="PenLine" text="选择左侧章节开始写作" class="editor-empty" />
  <div v-else class="editor-view">
    <header class="doc-head">
      <!-- 第一排：面包屑(左) + 保存态 + AI 按钮(右) -->
      <div class="doc-meta-row">
        <div v-if="crumbs.length" class="doc-crumbs">
          <template v-for="(c, i) in crumbs" :key="i">
            <span v-if="i > 0" class="doc-crumb-sep">›</span>
            <span class="doc-crumb">{{ c }}</span>
          </template>
        </div>
        <span v-if="saveStatus.text" class="save-pill" :class="saveStatus.cls">
          <span class="save-dot" />
          {{ saveStatus.text }}
        </span>
        <template v-if="entry.conflict">
          <button class="conflict-btn" @click="doc.reloadFromRemote(entry.docId)">重载远端</button>
          <button class="conflict-btn danger" @click="doc.overwriteRemote(entry.docId)">
            覆盖远端
          </button>
        </template>
        <div v-if="isReviewable" class="ai-tools">
          <button
            v-for="a in aiActions"
            :key="a.key"
            class="ai-tool-btn"
            :disabled="aiOff || rewrite.loading"
            :data-tip="aiOff ? 'AI 不可达' : a.label"
            data-tip-dir="bottom"
            @click="runAiAssist(a.instruction)"
          >
            <component :is="a.icon" :size="13" />
            <span>{{ a.label }}</span>
          </button>
          <Loader2 v-if="rewrite.loading" :size="13" class="ai-spin" />
        </div>
      </div>
      <!-- 第二排：标题居中 -->
      <div class="doc-title-row">
        <input
          v-if="isChapter"
          v-model="titleModel"
          class="inline-title editable"
          placeholder="未命名"
          @blur="onTitleCommit"
          @keydown.enter.prevent="onTitleCommit"
        />
        <input v-else class="inline-title" :value="entry.name" readonly placeholder="未命名" />
      </div>
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
  justify-content: center;
}
.editor-view {
  height: 100%;
  display: flex;
  flex-direction: column;
}
/* doc-head：第一排(面包屑+按钮) + 第二排(标题居中) */
.doc-head {
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  gap: var(--size-4-2);
  padding: var(--size-4-3) var(--size-4-6);
  border-bottom: 1px solid var(--background-modifier-border);
}
/* 第一排：面包屑靠左，保存药丸 + AI 工具条靠右 */
.doc-meta-row {
  display: flex;
  align-items: center;
  gap: var(--size-4-2);
  min-height: 28px;
}
.doc-crumbs {
  flex: 1;
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: var(--font-size-xs);
  color: var(--text-muted);
}
.doc-crumb-sep {
  opacity: 0.4;
}
/* 第二排：标题居中 */
.doc-title-row {
  display: flex;
  justify-content: center;
}
.inline-title {
  flex: none;
  text-align: center;
  min-width: 200px;
  max-width: 80%;
  border: none;
  outline: none;
  background: transparent;
  font-size: var(--font-size-xl);
  font-weight: 600;
  color: var(--text-normal);
  font-family: var(--prose-font);
}
/* chapter 可编辑标题：hover 有底色提示可点；内边距补偿保持视觉对齐 */
.inline-title.editable {
  cursor: text;
  border-radius: var(--radius-s);
  padding: 2px 6px;
  margin: -2px -6px;
  transition: background var(--dur-fast) var(--ease-out);
}
.inline-title.editable:hover {
  background: var(--background-modifier-hover);
}
/* 保存状态药丸 + 圆点指示器 */
.save-pill {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 2px 8px;
  border-radius: 10px;
  font-size: var(--font-size-xs);
  color: var(--text-muted);
  background: var(--background-modifier-hover);
}
.save-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--text-faint);
  flex-shrink: 0;
}
.save-pill.saved .save-dot { background: var(--dv-good); }
.save-pill.dirty .save-dot { background: var(--text-warning); }
.save-pill.err .save-dot { background: var(--text-error); }
.save-pill.saving .save-dot {
  background: var(--text-accent);
  animation: save-pulse 1s var(--ease-std) infinite;
}
@keyframes save-pulse {
  0%, 100% { opacity: 0.4; }
  50% { opacity: 1; }
}
.conflict-btn {
  flex-shrink: 0;
  font-size: var(--font-size-s);
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
/* AI 工具条容器（有边界感，成组而非散落）*/
.ai-tools {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: 1px;
  padding: 2px;
  border-radius: var(--radius-m);
  background: var(--background-secondary);
  border: 1px solid var(--background-modifier-border);
}
.ai-tool-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 3px 10px;
  border: none;
  border-radius: var(--radius-s);
  background: transparent;
  color: var(--text-muted);
  font-size: var(--font-size-xs);
  cursor: pointer;
  transition: background var(--dur-fast) var(--ease-out), color var(--dur-fast) var(--ease-out);
}
.ai-tool-btn:hover:not(:disabled) {
  background: var(--background-modifier-hover);
  color: var(--text-accent);
}
.ai-spin {
  color: var(--text-accent);
  animation: ai-spin 0.9s linear infinite;
}
@keyframes ai-spin {
  to { transform: rotate(360deg); }
}
.doc-body {
  flex: 1;
  min-height: 0;
  padding: var(--size-4-4) var(--size-4-6);
  overflow: hidden;
}
</style>
