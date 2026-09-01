<script setup lang="ts">
// 文档编辑视图：单行路径式顶栏（面包屑→标题合为一条，720px 居中对齐正文）+ CM6 正文。
// 巨石批 7b 拆分：顶栏整卡 → components/editor/EditorDocHead（标题编辑 v-model 双向），
// AI 辅助指令表/执行器 → composables/useAiAssist（顶栏按钮与右键菜单双消费）；
// 本文件留正文编辑（CmHost/正文 fm 剥离）、右键菜单、自动保存与文档打开编排。
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { PenLine } from 'lucide-vue-next'
import { useDocStore } from '../stores/doc'
import { useTreeStore } from '../stores/tree'
import { useWorkspaceStore } from '../stores/workspace'
import { useUiStore } from '../stores/ui'
import { getConfig } from '../api/books'
import { stripFrontmatter, mergeFm, parseFmFields, formKindOf, isBodyKind, countWords, splitFrontmatter } from '../shared/words'
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
  if (!hasForm.value) {
    doc.patch(e.docId, next)
    return
  }
  const merged = mergeFm(e.content, next)
  if (merged !== e.content) {
    doc.patch(e.docId, merged)
    return
  }
  // R31-30（三十一轮）：mergeFm 吞前导空行造成「编辑器变了、store 不变」的静默丢失窗
  //——正文首行回车是 ghost（CM6 有行、store/磁盘永不记录，外部同步/切文档时视觉跳回）。
  // 按编辑器为准补笔：typed 前导换行作为正文真实内容原样落（fm 分隔照常单行收敛），
  // store 与 CM6 一致，重载后 ghost 不再消失（展示层剥前导空行的既有口径不变）。
  if (next.startsWith('\n')) {
    const fm = splitFrontmatter(e.content)
    if (fm) doc.patch(e.docId, `---\n${fm.fmRaw}\n---\n\n${next}`)
  }
}
// R64-33（十二轮）：字数与服务端/右栏同源（countWords：码点计数 + 剥 markdown 标记）——
// 旧「去空白 UTF-16 计数」与右栏同屏可稳定不一致（markdown 标记/代理对字符）
const wordCount = computed(() => countWords(body.value))

const isChapter = computed(() => isBodyKind(entry.value?.path ?? ''))
const titleModel = ref('')
// F2（五十九轮）：标题编辑守卫——标题框聚焦（新标题未提交）或提交在途期间，watch 源
// entry.content 的任何变化（正文键入/refresh）不得回写 titleModel，否则未提交的新标题
// 被静默覆盖。切文档时强制脱离编辑态（输入框随文档切换失效，提交通道已不可能）。
const titleEditing = ref(false)
watch(
  [() => entry.value?.content, () => props.docId],
  ([c, id], old) => {
    if (old === undefined || old[1] !== id) titleEditing.value = false
    if (titleEditing.value) return
    const e = entry.value
    titleModel.value = e ? (parseFmFields(c ?? '').标题 ?? e.name) : ''
  },
  { immediate: true },
)

const { aiActions, runAiAssist } = useAiAssist()
// R35-37：右键 AI 动作按指令 key 取用——原按下标硬编码（aiActions[0..3]）与指令表
// 顺序隐式耦合，重排即静默错动作。零行为变更（当前顺序下动作映射不变）。
const aiActionByKey: Map<string, (typeof aiActions)[number]> = new Map(
  aiActions.map((a) => [a.key, a]),
)

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
  // R35-37：AI 子菜单项 key 形如 `ai-<指令key>`，按 key 查指令表取动作
  if (key.startsWith('ai-')) {
    const action = aiActionByKey.get(key.slice(3))
    if (action) void runAiAssist(action)
    return
  }
  switch (key) {
    case 'cut': await cmHost.value?.clipboardCut(); break
    case 'copy': await cmHost.value?.clipboardCopy(); break
    case 'paste': await cmHost.value?.clipboardPaste(); break
    case 'undo': cmHost.value?.undoAction(); break
    case 'redo': cmHost.value?.redoAction(); break
    case 'selectAll': cmHost.value?.selectAll(); break
    case 'find': cmHost.value?.openSearch(); break
  }
}

// P2-21：仅插入成功才消费，防无编辑器时文本静默丢失。
// 低级项（第六轮）：immediate 的回调在 setup 期执行时 cmHost 必为 null（模板 ref 未挂），
// 「挂载后补消费」实际不达——挂载时（onMounted）与 doc 异步打开落位后（nextTick）各补一次
function tryConsumeInsert(): void {
  const p = ws.pendingInsert
  if (!p) return
  if (cmHost.value) {
    cmHost.value.insertText(p.text)
    ws.consumeInsert()
  }
}
watch(() => ws.pendingInsert, () => tryConsumeInsert(), { immediate: true })

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
      // 低级项（第六轮）：doc 落位渲染出 CmHost 后补消费挂起中的插入信号
      //（挂载时 entry 尚空 → onMounted 那次消费不到，此后同值不再触发 watch）
      void nextTick().then(() => tryConsumeInsert())
    } catch (err) {
      ui.toast(friendlyError(err), 'error')
    }
  },
  { immediate: true },
)

// Q-9（第十五轮）：自动保存定时器上移 Book.vue（切到工作台/总览等视图后本组件卸载，
// 此前 dirty 文档随之停止自动保存）——此处只保留编辑器专属生命周期接线。
onMounted(() => {
  ws.setEditorGetSelection(() => cmHost.value?.getSelection() ?? '')
  // 低级项（第六轮）：immediate watch 在 setup 期 cmHost 为 null 消费不到——挂载补一次
  tryConsumeInsert()
})
onUnmounted(() => {
  ws.setEditorGetSelection(null)
})
</script>

<template>
  <EmptyState v-if="!entry" :icon="PenLine" text="选择左侧章节开始写作" class="editor-empty" />
  <div v-else class="editor-view" :class="{ 'editor-focus': ws.focusMode }">
    <EditorDocHead v-if="!ws.focusMode" v-model:title="titleModel" :doc-id="docId" :book-kind="bookKind" :word-count="wordCount" @update:title-editing="titleEditing = $event" />
    <div class="doc-body">
      <div class="doc-page">
        <!-- 标题居中（只读展示，编辑入口在顶栏）；专注模式下隐藏 -->
        <div v-if="!ws.focusMode" class="page-title-area">
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
/* 专注模式纸张宽度回归用户设置值（--page-width，见 .doc-page 基础规则）——
 * 不因专注刻意放大/收窄，调整入口移专注态右侧浮动排版条（FocusFormatBar） */
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
