<script setup lang="ts">
// CodeMirror 6 封装（细案 §5 editor/CmHost.vue）：Obsidian 风格正文编辑器。
// 无行号/无卡片边框、lineWrapping、正文字体（--prose-* 偏好）；md 模式加 markdown() 高亮。
import { ref, onMounted, onUnmounted, watch } from 'vue'
import { defaultKeymap, history, historyKeymap, undo, redo } from '@codemirror/commands'
import { markdown } from '@codemirror/lang-markdown'
import {
  HighlightStyle,
  bracketMatching,
  foldKeymap,
  indentOnInput,
  syntaxHighlighting,
} from '@codemirror/language'
import { highlightSelectionMatches, searchKeymap, openSearchPanel } from '@codemirror/search'
import { autocompletion, startCompletion, completionKeymap, type CompletionContext, type CompletionResult } from '@codemirror/autocomplete'
import { getCompletionNames } from '../api/settings'
import { useWorkspaceStore } from '../stores/workspace'
import { Compartment, EditorState, type Extension } from '@codemirror/state'
import {
  EditorView,
  crosshairCursor,
  drawSelection,
  dropCursor,
  highlightActiveLine,
  highlightSpecialChars,
  keymap,
  rectangularSelection,
} from '@codemirror/view'
import { tags as t } from '@lezer/highlight'

const props = defineProps<{ modelValue: string; mode: 'text' | 'md'; readonly?: boolean; typewriter?: boolean }>()
const emit = defineEmits<{
  'update:modelValue': [string]
  'selectionChange': []
}>()
const el = ref<HTMLElement>()
let view: EditorView | null = null

// 墨色为主的高亮（md 模式生效；text 模式纯文本）
const monoHighlight = HighlightStyle.define([
  { tag: t.heading, color: 'var(--text-normal)', fontWeight: '700' },
  { tag: t.strong, color: 'var(--text-normal)', fontWeight: '600' },
  { tag: t.emphasis, color: 'var(--text-normal)', fontStyle: 'italic' },
  { tag: [t.link, t.url], color: 'var(--text-accent)' },
  { tag: t.list, color: 'var(--text-accent)' },
  { tag: t.quote, color: 'var(--text-muted)' },
  { tag: t.meta, color: 'var(--text-faint)' },
  { tag: t.monospace, color: 'var(--text-muted)' },
])

// 外观：透明底贴 --background-primary，正文居中限宽，无焦点边框（Obsidian 风）
const editorTheme = EditorView.theme({
  '&': {
    backgroundColor: 'transparent',
    height: '100%',
    fontSize: 'var(--prose-size)',
    color: 'var(--text-normal)',
  },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': { fontFamily: 'var(--prose-font)', lineHeight: 'var(--prose-lh)' },
  '.cm-content': { caretColor: 'var(--text-accent)', padding: '0', maxWidth: 'var(--prose-max-width, 720px)', margin: '0 auto' },
  '.cm-line': { padding: '0' },
  '.cm-activeLine': { backgroundColor: 'var(--background-modifier-hover)' },
  // Autocomplete tooltip 美化（圆角卡片 + 阴影 + 选中高亮）
  '.cm-tooltip.cm-tooltip-autocomplete': {
    border: '1px solid var(--background-modifier-border)',
    borderRadius: '8px',
    background: 'var(--background-primary)',
    boxShadow: '0 6px 24px rgba(0,0,0,0.10)',
  },
  '.cm-tooltip-autocomplete > ul': {
    fontFamily: 'var(--font-ui)',
    fontSize: '14px',
  },
  '.cm-tooltip-autocomplete > ul > li': {
    padding: '5px 14px',
    borderRadius: '4px',
  },
  '.cm-tooltip-autocomplete > ul > li[aria-selected]': {
    background: 'var(--interactive-accent)',
    color: 'var(--text-on-accent)',
  },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground': {
    backgroundColor: 'var(--background-modifier-active-hover)',
  },
})

const editorSetup: Extension[] = [
  history(),
  drawSelection(),
  dropCursor(),
  EditorState.allowMultipleSelections.of(true),
  indentOnInput(),
  syntaxHighlighting(monoHighlight),
  bracketMatching(),
  rectangularSelection(),
  crosshairCursor(),
  highlightActiveLine(),
  highlightSpecialChars(),
  highlightSelectionMatches(),
  autocompletion({ override: [characterCompletion], activateOnTyping: true, icons: false }),
  EditorView.updateListener.of((u) => {
    // @ 触发角色名补全（CM6 默认 activateOnTyping 只认 \w，@ 不触发）
    if (!u.docChanged || !completionEntries.value.length) return
    const head = u.state.selection.main.head
    if (u.state.doc.sliceString(head - 1, head) === '@') startCompletion(u.view)
  }),
  keymap.of([
    { key: 'Mod-i', run: (v) => { startCompletion(v); return true } },
    ...defaultKeymap, ...searchKeymap, ...historyKeymap, ...foldKeymap, ...completionKeymap,
  ]),
]

// 补全名称：输入 @ 自动触发 或 Cmd+I 手动触发
interface NameEntry { label: string; detail: string }
const completionEntries = ref<NameEntry[]>([])
function characterCompletion(context: CompletionContext): CompletionResult | null {
  const entries = completionEntries.value
  if (!entries.length) return null

  // @ 触发：光标前有 @ 开头的文本
  const at = context.matchBefore(/@[一-鿿\w]*/)
  if (at && at.text.length >= 1) {
    const query = at.text.slice(1)
    const filtered = query ? entries.filter((e) => e.label.includes(query)) : entries
    if (filtered.length) {
      return {
        from: at.from,
        options: filtered.map((e) => ({ label: e.label, type: 'variable', detail: e.detail })),
        validFor: /^@?[一-鿿\w]*$/,
      }
    }
  }

  // 显式触发（Cmd+I / Ctrl+Space）：总是弹出全部名称，在光标位置插入
  if (!context.explicit) return null
  return {
    from: context.pos,
    options: entries.map((e) => ({ label: e.label, type: 'variable', detail: e.detail })),
    validFor: /^[一-鿿\w]*$/,
  }
}

// 打字机模式（专注时启用）：输入时当前行 scrollIntoView 居中（仅 docChanged，不干扰主动滚动查看）
function typewriterExt(on: boolean): Extension {
  if (!on) return []
  return EditorView.updateListener.of((u) => {
    if (!u.docChanged) return
    const head = u.state.selection.main.head
    const line = u.state.doc.lineAt(head)
    u.view.dispatch({ effects: EditorView.scrollIntoView(line.from, { y: 'center' }) })
  })
}
const typewriterConf = new Compartment()

onMounted(() => {
  if (!el.value) return
  view = new EditorView({
    doc: props.modelValue,
    extensions: [
      editorSetup,
      editorTheme,
      EditorView.lineWrapping,
      EditorState.readOnly.of(props.readonly ?? false),
      ...(props.mode === 'md' ? [markdown()] : []),
      EditorView.updateListener.of((u) => {
        if (u.docChanged) emit('update:modelValue', u.state.doc.toString())
        if (u.selectionSet || u.focusChanged) emit('selectionChange')
      }),
      typewriterConf.of(typewriterExt(props.typewriter ?? false)),
    ],
    parent: el.value,
  })
})

// 外部 modelValue 变（切文档）→ 同步；仅当差异时，避免光标跳
watch(
  () => props.modelValue,
  (v) => {
    if (view && v !== view.state.doc.toString()) {
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: v } })
    }
  },
)

// 补全名称列表（从设定 API 加载：角色名 + 物品名；@ / Cmd+I 触发用）
const ws = useWorkspaceStore()
watch(
  () => ws.bookName,
  async (name) => {
    if (!name || props.readonly) { completionEntries.value = []; return }
    try {
      const r = await getCompletionNames(name)
      completionEntries.value = [
        ...r.characters.map((n) => ({ label: n, detail: '角色' })),
        ...r.items.map((n) => ({ label: n, detail: '物品' })),
      ]
    } catch { /* 无设定数据 */ }
  },
  { immediate: true },
)

// 打字机开关（专注模式切换）：动态重配；进入时立即把当前行居中
watch(
  () => props.typewriter,
  (v) => {
    if (!view) return
    view.dispatch({ effects: typewriterConf.reconfigure(typewriterExt(v ?? false)) })
    if (v) {
      const head = view.state.selection.main.head
      const line = view.state.doc.lineAt(head)
      view.dispatch({ effects: EditorView.scrollIntoView(line.from, { y: 'center' }) })
    }
  },
)

/** 在光标处插入文本（右栏速查「插入」经 EditorView 调用；替换选区 + 滚动 + 回焦）。 */
function insertText(text: string): void {
  if (!view) return
  const sel = view.state.selection.main
  view.dispatch({
    changes: { from: sel.from, to: sel.to, insert: text },
    selection: { anchor: sel.from + text.length },
    scrollIntoView: true,
  })
  view.focus()
}

/** 取当前选区文本（空选区 → 空串；选段改写经 EditorView 调用）。 */
function getSelection(): string {
  if (!view) return ''
  const sel = view.state.selection.main
  return sel.from === sel.to ? '' : view.state.sliceDoc(sel.from, sel.to)
}
/** 取选区矩形（视口坐标），失焦或空选区返回 null（浮动工具栏定位用）*/
function getSelectionRect(): { left: number; top: number; right: number; bottom: number } | null {
  if (!view || !view.hasFocus) return null
  const sel = view.state.selection.main
  if (sel.from === sel.to) return null
  const a = view.coordsAtPos(sel.from)
  const b = view.coordsAtPos(sel.to)
  if (!a || !b) return null
  return {
    left: Math.min(a.left, b.left),
    right: Math.max(a.right, b.right),
    top: Math.min(a.top, b.top),
    bottom: Math.max(a.bottom, b.bottom),
  }
}
/** 是否有非空选区（右键菜单判断剪切/复制启用） */
function hasSelection(): boolean {
  if (!view) return false
  const sel = view.state.selection.main
  return sel.from !== sel.to
}
/** 剪切：复制选区到剪贴板并删除 */
async function clipboardCut(): Promise<void> {
  if (!view) return
  const sel = view.state.selection.main
  if (sel.from === sel.to) return
  try { await navigator.clipboard.writeText(view.state.sliceDoc(sel.from, sel.to)) } catch { /* 权限 */ }
  view.dispatch({ changes: { from: sel.from, to: sel.to, insert: '' } })
  view.focus()
}
/** 复制：复制选区到剪贴板 */
async function clipboardCopy(): Promise<void> {
  if (!view) return
  const sel = view.state.selection.main
  if (sel.from === sel.to) return
  try { await navigator.clipboard.writeText(view.state.sliceDoc(sel.from, sel.to)) } catch { /* 权限 */ }
  view.focus()
}
/** 粘贴：从剪贴板读取并替换选区 */
async function clipboardPaste(): Promise<void> {
  if (!view) return
  try {
    const text = await navigator.clipboard.readText()
    const sel = view.state.selection.main
    view.dispatch({ changes: { from: sel.from, to: sel.to, insert: text }, selection: { anchor: sel.from + text.length }, scrollIntoView: true })
  } catch { /* 权限 */ }
  view.focus()
}
/** 全选 */
function selectAll(): void {
  if (!view) return
  view.dispatch({ selection: { anchor: 0, head: view.state.doc.length } })
  view.focus()
}
/** 撤销 */
function undoAction(): void {
  if (!view) return
  undo(view)
  view.focus()
}
/** 重做 */
function redoAction(): void {
  if (!view) return
  redo(view)
  view.focus()
}
/** 打开查找面板 */
function openSearch(): void {
  if (!view) return
  openSearchPanel(view)
  view.focus()
}
defineExpose({ insertText, getSelection, getSelectionRect, hasSelection, clipboardCut, clipboardCopy, clipboardPaste, selectAll, undoAction, redoAction, openSearch })

onUnmounted(() => view?.destroy())
</script>

<template>
  <div ref="el" class="cm-host"></div>
</template>

<style scoped>
.cm-host {
  height: 100%;
}
.cm-host :deep(.cm-editor) {
  height: 100%;
}
.cm-host :deep(.cm-scroller) {
  overflow: auto;
}
/* 编辑器滚动条：比全局更细（6px → 近 Obsidian 极简风） */
.cm-host :deep(.cm-scroller)::-webkit-scrollbar {
  width: 6px;
  height: 6px;
}
.cm-host :deep(.cm-scroller)::-webkit-scrollbar-thumb {
  background: var(--background-modifier-border);
  border-radius: 3px;
}
.cm-host :deep(.cm-scroller)::-webkit-scrollbar-thumb:hover {
  background: var(--background-modifier-border-hover);
}
</style>
