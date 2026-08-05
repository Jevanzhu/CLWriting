<script setup lang="ts">
// 文档编辑视图：单行路径式顶栏（面包屑→标题合为一条，720px 居中对齐正文）+ CM6 正文。
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { PenLine, Loader2, Save, Check, Lock } from 'lucide-vue-next'
import { useDocStore } from '../stores/doc'
import { useTreeStore } from '../stores/tree'
import { useWorkspaceStore } from '../stores/workspace'
import { useUiStore } from '../stores/ui'
import { useRewriteStore } from '../stores/rewrite'
import { updateChapterMetaDoc } from '../api/documents'
import { getConfig } from '../api/books'
import { usePrefsStore } from '../stores/prefs'
import { stripFrontmatter, mergeFm, parseFmFields, formKindOf, isBodyKind } from '../shared/words'
import CmHost from '../editor/CmHost.vue'
import ContextMenu from '../components/ui/ContextMenu.vue'
import type { MenuItem } from '../components/ui/ContextMenu.vue'
import { useNativeMenu } from '../composables/useNativeMenu'
import EmptyState from '../components/ui/EmptyState.vue'
import { friendlyError } from '../shared/error'

const props = defineProps<{ docId: string | null }>()
const doc = useDocStore()
const tree = useTreeStore()
const ws = useWorkspaceStore()
const ui = useUiStore()
const rewrite = useRewriteStore()
const prefs = usePrefsStore()

const aiOff = computed(() => ui.aiAvailable === false)
const isReviewable = computed(() => {
  if (!entry.value) return false
  if (formKindOf(entry.value.path) !== null) return true
  return /^写作\/草稿\/草稿-\d+\.md$/.test(entry.value.path)
})

// 面包屑：文档路径到父目录（末级=文件名=标题，不重复）
const crumbs = computed(() => {
  const p = entry.value?.path ?? ''
  return p.replace(/\.md$/, '').split('/').slice(0, -1).filter(Boolean)
})

// 章节正文状态（TreeNode.status → 中文标签）
const STATUS_LABEL: Record<string, string> = {
  idea: '构想', draft: '草稿', revision: '修订',
  final: '定稿', published: '已发布', archived: '已归档',
}
const chapterStatus = computed(() => {
  if (!props.docId) return null
  const node = tree.byDocId.get(props.docId)
  const s = node?.status
  return s ? STATUS_LABEL[s] ?? null : null
})
// 状态色（和章节树六态对齐）：final·published 绿 / revision 红 / draft 黄 / 其余灰
const statusCls = computed(() => {
  if (!props.docId) return ''
  const s = tree.byDocId.get(props.docId)?.status
  switch (s) {
    case 'final':
    case 'published':
      return 'st-good'
    case 'revision':
      return 'st-bad'
    case 'draft':
      return 'st-warn'
    default:
      return 'st-faint'
  }
})

const saveStatus = computed<{ text: string; cls: string }>(() => {
  const e = entry.value
  if (!e) return { text: '', cls: '' }
  if (e.saving) return { text: '保存中', cls: 'saving' }
  if (e.error) return { text: '保存失败', cls: 'err' }
  if (e.dirty) return { text: '未保存', cls: 'dirty' }
  if (e.savedAt) return { text: '已保存', cls: 'saved' }
  return { text: '', cls: '' }
})

/** 保存按钮标签（dirty→保存 / saved→已保存 / err→重试）。 */
const saveBtnLabel = computed(() => {
  const e = entry.value
  if (!e) return '保存'
  if (e.saving) return '保存中'
  if (e.error) return '重试'
  return e.dirty ? '保存' : '已保存'
})

/** 手动保存（按钮 + ⌘S/Ctrl+S）。 */
function onSave(): void {
  const e = entry.value
  if (!e || e.saving || (!e.dirty && !e.error)) return
  void doc.save(e.docId, 'manual')
}

// 定稿确认：revision 态正文/设定可定稿（final 已定稿不显；草稿入卷属 P2）
const isFinalizable = computed(() => {
  if (!props.docId) return false
  const node = tree.byDocId.get(props.docId)
  if (!node || node.isDirectory) return false
  if (!node.path.startsWith('写作/正文/')) return false // 仅正文章节可定稿（草稿/设定/大纲不参与）
  return node.status === 'revision'
})
const finalizing = ref(false)
async function onFinalize(): Promise<void> {
  if (!props.docId || finalizing.value) return
  finalizing.value = true
  try {
    await doc.finalize(props.docId)
  } finally {
    finalizing.value = false
  }
}
function onKeydown(e: KeyboardEvent): void {
  if ((e.metaKey || e.ctrlKey) && (e.key === 's' || e.key === 'S')) {
    e.preventDefault()
    onSave()
  }
}

const aiActions = [
  { key: 'expand', label: '扩写', instruction: '扩写选中段落，增加场景细节、感官描写和角色心理活动' },
  { key: 'condense', label: '缩写', instruction: '压缩选中段落，去掉冗余对话和描写，保留核心信息和情节走向' },
  { key: 'polish', label: '润色', instruction: '润色选中段落的文风和用词，提升文学性，不改变情节走向' },
  { key: 'continue', label: '续写', instruction: '保留原文不变，在后面续写200-500字，延续当前风格和情节' },
] as const

async function runAiAssist(action: { key: string; instruction: string }): Promise<void> {
  const sel = ws.editorGetSelection?.() ?? ''
  // M2 续写解选区：无选区的续写走 append（空白页/卡壳时刻）；其余动作仍需选区靶点
  const isAppend = action.key === 'continue' && !sel
  if (!sel && !isAppend) {
    ui.toast('请先选中要操作的文字', 'info')
    return
  }
  if (!ws.activeDocId || !doc.bookName) return
  ws.setRightTab('review')
  await rewrite.run(doc.bookName, ws.activeDocId, action.instruction, sel, isAppend)
}
type CmHostExposed = {
  insertText: (t: string) => void
  getSelection: () => string
  hasSelection: () => boolean
  clipboardCut: () => Promise<void>
  clipboardCopy: () => Promise<void>
  clipboardPaste: () => Promise<void>
  selectAll: () => void
  undoAction: () => void
  redoAction: () => void
  openSearch: () => void
}
const cmHost = ref<CmHostExposed | null>(null)

// 右键菜单（桌面端 → macOS 原生 Menu；浏览器 → 自定义 ContextMenu）
const { isNative, menuVisible, menuX, menuY, menuItems, popup, onPopupSelect, onPopupClose } = useNativeMenu()

function onContextMenu(e: MouseEvent): void {
  const hasSel = cmHost.value?.hasSelection() ?? false
  popup(buildCtxItems(hasSel), e.clientX, e.clientY, onCtxSelect)
}

function buildCtxItems(hasSel: boolean): MenuItem[] {
  const items: MenuItem[] = [
    { key: 'cut', label: '剪切', accelerator: 'CmdOrCtrl+X', disabled: !hasSel },
    { key: 'copy', label: '复制', accelerator: 'CmdOrCtrl+C', disabled: !hasSel },
    { key: 'paste', label: '粘贴', accelerator: 'CmdOrCtrl+V' },
    { key: 'sep1', label: '', separator: true },
    { key: 'undo', label: '撤销', accelerator: 'CmdOrCtrl+Z' },
    { key: 'redo', label: '重做', accelerator: 'CmdOrCtrl+Shift+Z' },
    { key: 'sep2', label: '', separator: true },
    { key: 'selectAll', label: '全选', accelerator: 'CmdOrCtrl+A' },
    { key: 'sep3', label: '', separator: true },
    { key: 'find', label: '查找', accelerator: 'CmdOrCtrl+F' },
  ]
  if (isReviewable.value && !aiOff.value) {
    items.push({ key: 'sep4', label: '', separator: true })
    items.push({
      key: 'ai',
      label: 'AI 辅助',
      submenu: aiActions.map(a => ({
        key: `ai-${a.key}`,
        label: a.label,
        disabled: !hasSel,
      })),
    })
  }
  return items
}

async function onCtxSelect(key: string): Promise<void> {
  switch (key) {
    case 'cut': await cmHost.value?.clipboardCut(); break
    case 'copy': await cmHost.value?.clipboardCopy(); break
    case 'paste': await cmHost.value?.clipboardPaste(); break
    case 'undo': cmHost.value?.undoAction(); break
    case 'redo': cmHost.value?.redoAction(); break
    case 'selectAll': cmHost.value?.selectAll(); break
    case 'find': cmHost.value?.openSearch(); break
    case 'ai-expand': void runAiAssist(aiActions[0]); break
    case 'ai-condense': void runAiAssist(aiActions[1]); break
    case 'ai-polish': void runAiAssist(aiActions[2]); break
    case 'ai-continue': void runAiAssist(aiActions[3]); break
  }
}

const wordCount = computed(() => body.value.replace(/\s/g, '').length)

watch(
  () => ws.pendingInsert,
  (text) => {
    if (!text) return
    // P2-21：仅插入成功才消费，防无编辑器时文本静默丢失
    if (cmHost.value) {
      cmHost.value.insertText(text)
      ws.consumeInsert()
    }
  },
)

const entry = computed(() => (props.docId ? doc.get(props.docId) : undefined))

// 当前书类型（长篇/短篇），顶栏 pill 展示；切书时重新拉取 book.yaml
const bookKind = ref<'long' | 'short' | null>(null)
let kindReqId = 0
watch(
  () => doc.bookName,
  async (name) => {
    if (!name) {
      bookKind.value = null
      return
    }
    const reqId = ++kindReqId
    try {
      const cfg = await getConfig(name)
      if (reqId !== kindReqId) return // P2-19：丢弃过期结果
      bookKind.value = cfg.kind === 'short' ? 'short' : 'long'
    } catch {
      if (reqId !== kindReqId) return
      bookKind.value = null
    }
  },
  { immediate: true },
)
const hasForm = computed(() => (entry.value ? formKindOf(entry.value.path) !== null : false))
const body = computed(() => {
  const c = entry.value?.content ?? ''
  return hasForm.value ? stripFrontmatter(c).replace(/^\n+/, '') : c
})
function onBodyChange(next: string): void {
  const e = entry.value
  if (!e) return
  doc.patch(e.docId, hasForm.value ? mergeFm(e.content, next) : next)
}

const isChapter = computed(() => isBodyKind(entry.value?.path ?? ''))
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
    // 短篇传 篇号（占位沿用现有值，仅改标题）；后端按 piece-body 落 fm + 篇目录 rename
    // P2：fm 缺篇号时从文件名提取（防 fallback 1 覆盖真实篇号）
    const pieceNum = e.role === 'piece-body'
      ? Number(parseFmFields(e.content).篇号 ?? Number(e.path.match(/(\d+)-[^/]*\.md$/)?.[1] ?? 1))
      : undefined
    await updateChapterMetaDoc(doc.bookName!, ws.activeDocId, {
      标题: newTitle,
      ...(e.role === 'piece-body' && pieceNum !== undefined ? { 篇号: pieceNum } : {}),
    })
    await tree.load(doc.bookName!)
    const fresh = tree.byDocId.get(ws.activeDocId)
    if (fresh) {
      e.path = fresh.path
      e.name = fresh.name
    }
    // refresh 前抓最新本地正文（含上述 await 期间用户编辑），防 refresh 覆盖丢失正文
    const localBody = stripFrontmatter(e.content)
    await doc.refresh(ws.activeDocId)
    const refreshed = doc.get(ws.activeDocId)
    if (refreshed && stripFrontmatter(refreshed.content) !== localBody) {
      doc.patch(ws.activeDocId, mergeFm(refreshed.content, localBody))
    }
  } catch (err) {
    ui.toast(friendlyError(err), 'error')
  } finally {
    titleSaving.value = false
  }
}

watch(
  () => props.docId,
  async (id) => {
    if (id && !doc.get(id)) {
      const node = tree.byDocId.get(id)
      if (node) {
        try { await doc.open(node) } catch { /* 静默 */ }
      }
    }
  },
  { immediate: true },
)

let timer: ReturnType<typeof setInterval> | null = null
function tick(): void {
  if (entry.value?.dirty && !entry.value.saving) {
    void doc.save(entry.value.docId, 'autosave')
  }
}
function startTimer(): void {
  if (timer) clearInterval(timer)
  timer = setInterval(tick, Math.max(5, prefs.effectiveAutosaveInterval) * 1000)
}
onMounted(() => {
  startTimer()
  ws.setEditorGetSelection(() => cmHost.value?.getSelection() ?? '')
  window.addEventListener('keydown', onKeydown)
})
watch(() => prefs.effectiveAutosaveInterval, startTimer)
onUnmounted(() => {
  if (timer) clearInterval(timer)
  ws.setEditorGetSelection(null)
  window.removeEventListener('keydown', onKeydown)
})
</script>

<template>
  <EmptyState v-if="!entry" :icon="PenLine" text="选择左侧章节开始写作" class="editor-empty" />
  <div v-else class="editor-view">
    <!-- 顶栏 wrapper：和 doc-body 共享左右 padding，保证卡片宽度同步 -->
    <div class="doc-head-slot">
      <header class="doc-head">
      <div class="doc-bar">
        <!-- 左：类型 pill · 面包屑 → 标题（完整路径） -->
        <div class="bar-left">
          <span v-if="bookKind" class="book-kind" :class="bookKind">{{ bookKind === 'long' ? '长篇' : '短篇' }}</span>
          <span v-if="bookKind" class="bar-split" />
          <template v-for="(c, i) in crumbs" :key="i">
            <span v-if="i > 0" class="bar-sep">›</span>
            <span class="bar-crumb">{{ c }}</span>
          </template>
          <span v-if="crumbs.length" class="bar-sep">›</span>
          <input
            v-if="isChapter"
            v-model="titleModel"
            class="bar-title editable"
            placeholder="未命名"
            @blur="onTitleCommit"
            @keydown.enter.prevent="onTitleCommit"
          />
          <span v-else class="bar-title">{{ entry.name }}</span>
        </div>
        <!-- 右：字数 · 状态 · 冲突 · AI · 保存（最右） -->
        <div class="bar-right">
          <span class="word-count">{{ wordCount.toLocaleString() }} 字</span>
          <span v-if="chapterStatus" class="doc-status" :class="statusCls">{{ chapterStatus }}</span>
          <template v-if="entry.conflict">
            <button class="conflict-btn" @click="doc.reloadFromRemote(entry.docId)">重载</button>
            <button class="conflict-btn danger" @click="doc.overwriteRemote(entry.docId)">覆盖</button>
          </template>
          <div v-if="isReviewable" class="ai-group">
            <button
              v-for="a in aiActions"
              :key="a.key"
              class="ai-btn"
              :disabled="aiOff || rewrite.loading"
              :data-tip="aiOff ? 'AI 暂不可用' : a.label"
              data-tip-dir="bottom"
              @click="runAiAssist(a)"
            >
              {{ a.label }}
            </button>
            <Loader2 v-if="rewrite.loading" :size="12" class="ai-btn-spin" />
          </div>
          <button
            v-if="isFinalizable"
            class="finalize-btn"
            :disabled="finalizing || entry.saving"
            data-tip="定稿（锁定当前版本，git 提交）"
            data-tip-dir="bottom"
            @click="onFinalize"
          >
            <Loader2 v-if="finalizing" :size="12" class="save-btn-spin" />
            <Lock v-else :size="12" />
            <span>{{ finalizing ? '定稿中…' : '定稿' }}</span>
          </button>
          <div class="save-group">
            <button
              class="save-btn"
              :class="saveStatus.cls"
              :disabled="entry.saving || (!entry.dirty && !entry.error)"
              data-tip="保存（⌘S）"
              data-tip-dir="bottom"
              @click="onSave"
            >
              <Loader2 v-if="entry.saving" :size="12" class="save-btn-spin" />
              <Check v-else-if="entry.savedAt && !entry.dirty" :size="12" />
              <Save v-else :size="12" />
              <span>{{ saveBtnLabel }}</span>
            </button>
          </div>
        </div>
      </div>
    </header>
    </div>
    <div class="doc-body">
      <div class="doc-page">
        <!-- 标题居中 -->
        <div class="page-title-area">
          <input
            v-if="isChapter"
            v-model="titleModel"
            class="page-title editable"
            placeholder="未命名"
            @blur="onTitleCommit"
            @keydown.enter.prevent="onTitleCommit"
          />
          <span v-else class="page-title">{{ entry.name }}</span>
        </div>
        <!-- 正文编辑器 -->
        <div class="page-editor" @contextmenu.prevent="onContextMenu">
          <CmHost
            ref="cmHost"
            :model-value="body"
            :mode="entry.mode"
            :typewriter="ws.focusMode"
            @update:model-value="onBodyChange"
          />
        </div>
        <i class="crop cm-tl" />
        <i class="crop cm-tr" />
        <i class="crop cm-bl" />
        <i class="crop cm-br" />
      </div>
    </div>
    <ContextMenu
      v-if="!isNative"
      :visible="menuVisible"
      :x="menuX"
      :y="menuY"
      :items="menuItems"
      @select="onPopupSelect"
      @close="onPopupClose"
    />
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
  background: var(--background-secondary);
  /* 统一左右 padding（doc-head 和 doc-body 共享） */
  --doc-pad-x: var(--size-4-12);
  /* 角标参数（全局共享） */
  --crop-size: 40px;
  --crop-edge: 90px;
  --crop-gap: 10px;
  /* 正文宽度 = 纸张宽度 - 两侧(角标边距 + 角标大小 + 间距) */
  --prose-max-width: max(320px, calc(100% - 2 * (var(--crop-edge) + var(--crop-size) + var(--crop-gap))));
}

/* ===== 独立顶栏（白底卡片，和正文纸张同风格） ===== */
.doc-head-slot {
  flex-shrink: 0;
  padding: 0 var(--doc-pad-x);
}
.doc-head {
  max-width: var(--page-width, 1020px);
  width: 100%;
  margin: var(--size-4-3) auto 0;
  background: var(--background-primary);
  border: 1px solid var(--background-modifier-border);
  border-radius: var(--radius-s);
  box-shadow: var(--shadow-s);
  padding: var(--size-4-2) var(--size-4-3);
}
.doc-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--size-4-3);
  min-height: 30px;
}

/* 左：类型 pill · 面包屑 → 标题 */
.bar-left {
  display: flex;
  align-items: baseline;
  gap: 6px;
  overflow: hidden;
  font-size: var(--font-size-s);
  color: var(--text-faint);
}
/* 长篇/短篇 类型 pill（蓝/橙，与状态色绿红黄区分） */
.book-kind {
  flex-shrink: 0;
  padding: 1px 8px;
  border-radius: var(--radius-s);
  font-size: var(--font-size-xs);
  font-weight: 600;
  white-space: nowrap;
}
.book-kind.long {
  color: var(--cat-4);
  background: color-mix(in srgb, var(--cat-4) 14%, transparent);
}
.book-kind.short {
  color: var(--cat-2);
  background: color-mix(in srgb, var(--cat-2) 14%, transparent);
}
/* pill 与面包屑间的短分隔线（与 AI 区分隔风格统一） */
.bar-split {
  align-self: center;
  flex-shrink: 0;
  width: 1px;
  height: 14px;
  margin-left: 6px;
  margin-right: 6px;
  background: var(--background-modifier-border);
}
.bar-crumb {
  white-space: nowrap;
}
.bar-sep {
  opacity: 0.35;
}
.bar-title {
  font-size: var(--font-size-s);
  font-weight: 600;
  color: var(--text-normal);
  white-space: nowrap;
  border: none;
  outline: none;
  background: transparent;
  font-family: var(--prose-font);
}
.bar-title.editable {
  border-radius: var(--radius-s);
  padding: 1px 6px;
  margin: -1px -6px;
  cursor: text;
  transition: background var(--dur-fast) var(--ease-out);
}
.bar-title.editable:hover,
.bar-title.editable:focus {
  background: var(--background-modifier-hover);
}
/* 纸张内标题（绝对定位，在角标上方） */
.page-title-area {
  position: absolute;
  top: var(--size-4-6);
  left: 0;
  right: 0;
  max-width: var(--prose-max-width);
  margin: 0 auto;
  z-index: 2;
  text-align: center;
}
.page-title {
  font-size: var(--font-size-2xl);
  font-weight: 700;
  line-height: 1.3;
  color: var(--text-normal);
  font-family: var(--prose-font);
  border: none;
  outline: none;
  background: transparent;
  text-align: center;
  width: 100%;
}
.page-title.editable {
  border-radius: var(--radius-s);
  padding: 2px var(--size-4-2);
  cursor: text;
  transition: background var(--dur-fast) var(--ease-out);
}
.page-title.editable:hover,
.page-title.editable:focus {
  background: var(--background-modifier-hover);
}
.page-editor {
  height: 100%;
}

/* 右：状态 + AI */
.bar-right {
  display: flex;
  align-items: center;
  gap: var(--size-4-3);
  flex-shrink: 0;
}
.word-count {
  font-size: var(--font-size-xs);
  padding: 1px 8px;
  border-radius: var(--radius-s);
  color: var(--text-accent);
  background: color-mix(in srgb, var(--text-accent) 12%, transparent);
  font-weight: 500;
  font-variant-numeric: tabular-nums;
}
.doc-status {
  font-size: var(--font-size-xs);
  padding: 1px 8px;
  border-radius: var(--radius-s);
}
.doc-status.st-good {
  color: var(--dv-good);
  background: color-mix(in srgb, var(--dv-good) 12%, transparent);
}
.doc-status.st-bad {
  color: var(--text-error);
  background: color-mix(in srgb, var(--text-error) 12%, transparent);
}
.doc-status.st-warn {
  color: var(--text-warning);
  background: color-mix(in srgb, var(--text-warning) 12%, transparent);
}
.doc-status.st-faint {
  color: var(--text-faint);
  background: var(--background-modifier-hover);
}
/* 保存按钮：与 AI 按钮同款 pill（同 padding/字号/圆角），置于最右；所有状态都有
   底色框（idle 灰 / dirty 实色翠绿 / saving·saved 绿软底 / err 红软底），
   padding/高度/框样式跨状态一致 → 形状规格统一。 */
.save-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 3px 10px;
  border: none;
  border-radius: var(--radius-s);
  background: var(--background-modifier-hover);
  color: var(--text-muted);
  font-size: var(--font-size-xs);
  cursor: pointer;
  transition: background var(--dur-fast) var(--ease-out), color var(--dur-fast) var(--ease-out);
}
/* 定稿按钮：revision 态提示色，与「保存」（写文件）对偶——定稿=锁定版本 */
.finalize-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 3px 10px;
  border: 1px solid var(--background-modifier-border);
  border-radius: var(--radius-s);
  background: var(--interactive-accent);
  color: var(--text-on-accent);
  font-size: var(--font-size-xs);
  cursor: pointer;
  margin-right: 4px;
  transition: opacity var(--dur-fast) var(--ease-out);
}
.finalize-btn:hover:not(:disabled) {
  opacity: 0.88;
}
.finalize-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
/* dirty：实色翠绿——主操作态，与 AI 实色 pill 同形态、换绿色相 */
.save-btn.dirty {
  background: var(--dv-good);
  color: var(--text-on-accent);
}
.save-btn.dirty:hover {
  background: color-mix(in srgb, var(--dv-good) 88%, white);
}
/* saving：翠绿软底 + 转圈（进行中，保持操作色相） */
.save-btn.saving {
  background: color-mix(in srgb, var(--dv-good) 22%, transparent);
  color: var(--dv-good);
}
/* saved：淡翠绿软底 + ✓（完成态；保留框，与其他状态边缘对齐） */
.save-btn.saved {
  background: color-mix(in srgb, var(--dv-good) 14%, transparent);
  color: var(--dv-good);
}
/* err：红软底——可点重试 */
.save-btn.err {
  color: var(--text-error);
  background: color-mix(in srgb, var(--text-error) 14%, transparent);
}
.save-btn.err:hover {
  background: color-mix(in srgb, var(--text-error) 22%, transparent);
}
.save-btn:hover:not(:disabled):not(.dirty):not(.err) {
  background: var(--background-modifier-hover);
  color: var(--text-normal);
}
.save-btn:disabled {
  cursor: default;
}
.save-btn-spin {
  animation: ai-btn-rot 0.9s linear infinite;
}
.conflict-btn {
  font-size: var(--font-size-xs);
  padding: 2px 8px;
  border: 1px solid var(--background-modifier-border);
  border-radius: var(--radius-s);
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
}
.conflict-btn:hover { background: var(--background-modifier-hover); color: var(--text-normal); }
.conflict-btn.danger:hover { color: var(--text-error); }

/* AI 按钮 */
.ai-group {
  display: flex;
  align-items: center;
  gap: var(--size-4-1);
  padding-left: var(--size-4-3);
  border-left: 1px solid var(--background-modifier-border);
}
/* 保存按钮组：与 ai-group 对称（border-left + 同款 padding-left），分隔线两侧间距一致 */
.save-group {
  display: flex;
  align-items: center;
  padding-left: var(--size-4-3);
  border-left: 1px solid var(--background-modifier-border);
}
.ai-btn {
  padding: 3px 10px;
  border: none;
  border-radius: var(--radius-s);
  background: var(--interactive-accent);
  color: var(--text-on-accent);
  font-size: var(--font-size-xs);
  cursor: pointer;
  transition: background var(--dur-fast) var(--ease-out);
}
.ai-btn:hover:not(:disabled) {
  background: var(--interactive-accent-hover);
}
.ai-btn:disabled {
  opacity: 0.35;
  cursor: not-allowed;
}
.ai-btn-spin {
  color: var(--text-accent);
  margin: 0 4px;
  animation: ai-btn-rot 0.9s linear infinite;
}
@keyframes ai-btn-rot {
  to { transform: rotate(360deg); }
}

/* ===== Word 风格纸张 ===== */
.doc-body {
  flex: 1;
  min-height: 0;
  padding: var(--size-4-3) var(--doc-pad-x) var(--size-4-5);
  overflow: hidden;
}
.doc-page {
  --page-pad: 105px;
  position: relative;
  height: 100%;
  max-width: var(--page-width, 1020px);
  margin: 0 auto;
  background: var(--background-primary);
  border: 1px solid var(--background-modifier-border);
  border-radius: var(--radius-s);
  box-shadow: var(--shadow-s), var(--shadow-l);
  overflow: hidden;
  padding: var(--page-pad) 0;
}
.crop {
  position: absolute;
  width: var(--crop-size);
  height: var(--crop-size);
  pointer-events: none;
  z-index: 1;
}
.cm-tl {
  top: calc(var(--page-pad) - var(--crop-size));
  left: min(var(--crop-edge), calc(50% - var(--crop-size) - var(--crop-gap)));
  border-right: 1px solid var(--background-modifier-border-active);
  border-bottom: 1px solid var(--background-modifier-border-active);
}
.cm-tr {
  top: calc(var(--page-pad) - var(--crop-size));
  right: min(var(--crop-edge), calc(50% - var(--crop-size) - var(--crop-gap)));
  border-left: 1px solid var(--background-modifier-border-active);
  border-bottom: 1px solid var(--background-modifier-border-active);
}
.cm-bl {
  bottom: calc(var(--page-pad) - var(--crop-size));
  left: min(var(--crop-edge), calc(50% - var(--crop-size) - var(--crop-gap)));
  border-right: 1px solid var(--background-modifier-border-active);
  border-top: 1px solid var(--background-modifier-border-active);
}
.cm-br {
  bottom: calc(var(--page-pad) - var(--crop-size));
  right: min(var(--crop-edge), calc(50% - var(--crop-size) - var(--crop-gap)));
  border-left: 1px solid var(--background-modifier-border-active);
  border-top: 1px solid var(--background-modifier-border-active);
}
</style>
