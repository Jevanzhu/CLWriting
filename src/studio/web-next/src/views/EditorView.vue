<script setup lang="ts">
// 文档编辑视图：单行路径式顶栏（面包屑→标题合为一条，720px 居中对齐正文）+ CM6 正文。
// 巨石批 7b 拆分：顶栏整卡 → components/editor/EditorDocHead（标题编辑 v-model 双向），
// AI 辅助指令表/执行器 → composables/useAiAssist（顶栏按钮与右键菜单双消费）；
// 本文件留正文编辑（CmHost/正文 fm 剥离）、右键菜单、自动保存与文档打开编排。
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { PenLine } from 'lucide-vue-next'
import { useDocStore } from '../stores/doc'
import { useTreeStore } from '../stores/tree'
import { useWorkspaceStore } from '../stores/workspace'
import { useUiStore } from '../stores/ui'
import { usePrefsStore } from '../stores/prefs'
import { getConfig } from '../api/books'
import { stripFrontmatter, mergeFm, parseFmFields, formKindOf, isBodyKind } from '../shared/words'
import CmHost from '../editor/CmHost.vue'
import EditorDocHead from '../components/editor/EditorDocHead.vue'
import ContextMenu from '../components/ui/ContextMenu.vue'
import type { MenuItem } from '../components/ui/ContextMenu.vue'
import { useNativeMenu } from '../composables/useNativeMenu'
import { useAiAssist } from '../composables/useAiAssist'
import EmptyState from '../components/ui/EmptyState.vue'
import { friendlyError } from '../shared/error'

const props = defineProps<{ docId: string | null }>()
const doc = useDocStore()
const tree = useTreeStore()
const ws = useWorkspaceStore()
const ui = useUiStore()
const prefs = usePrefsStore()

const aiOff = computed(() => ui.aiAvailable === false)
const isReviewable = computed(() => {
  if (!entry.value) return false
  if (formKindOf(entry.value.path) !== null) return true
  return isBodyKind(entry.value.path)
})

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
const wordCount = computed(() => body.value.replace(/\s/g, '').length)

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

const { aiActions, runAiAssist } = useAiAssist()

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

watch(
  // CC-P1-4：同时挂 docId 和 tree.byDocId——恢复持久化 activeDocId 时 getBookPrefs（快）
  // 可能先于 tree.load（慢，大书含 git status + 全盘字数）返回，此时 byDocId 为空；
  // 仅 watch docId 会触发一次空查找后静默放弃，树到达后无补偿重试 → 编辑器停留空态。
  // 挂上 byDocId.get(docId) 后树加载完成 watch 重触发，补开恢复的文档。
  [() => props.docId, () => (props.docId ? tree.byDocId.get(props.docId) : undefined)],
  async ([id]) => {
    if (!id || doc.get(id)) return
    const node = tree.byDocId.get(id)
    if (!node) return
    // V-P2-28：打开失败不再静默——空编辑器无提示会让作者以为内容丢了
    try {
      await doc.open(node)
    } catch (err) {
      ui.toast(friendlyError(err), 'error')
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
})
watch(() => prefs.effectiveAutosaveInterval, startTimer)
onUnmounted(() => {
  if (timer) clearInterval(timer)
  ws.setEditorGetSelection(null)
})
</script>

<template>
  <EmptyState v-if="!entry" :icon="PenLine" text="选择左侧章节开始写作" class="editor-empty" />
  <div v-else class="editor-view">
    <EditorDocHead v-model:title="titleModel" :doc-id="docId" :book-kind="bookKind" :word-count="wordCount" />
    <div class="doc-body">
      <div class="doc-page">
        <!-- 标题居中（只读展示，编辑入口在顶栏） -->
        <div class="page-title-area">
          <span class="page-title">{{ isChapter ? (titleModel || '未命名') : entry.name }}</span>
        </div>
        <!-- 正文编辑器 -->
        <div class="page-editor" @contextmenu.prevent="onContextMenu">
          <CmHost
            ref="cmHost"
            :model-value="body"
            :mode="entry.mode"
            :typewriter="ws.focusMode"
            :history-key="docId ?? undefined"
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
.page-editor {
  height: 100%;
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
