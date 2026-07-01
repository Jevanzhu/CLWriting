<script setup lang="ts">
// CodeMirror 6 包装：mono 语法高亮（替换彩色 defaultHighlightStyle）+ 外观对齐 mockup .prose。
// CM6 是 DOM 渲染（非 canvas），CSS var 可直接用于高亮/主题。
import { ref, onMounted, onUnmounted, watch } from 'vue'
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import { markdown } from '@codemirror/lang-markdown'
import {
  HighlightStyle,
  bracketMatching,
  foldGutter,
  foldKeymap,
  indentOnInput,
  syntaxHighlighting,
} from '@codemirror/language'
import { highlightSelectionMatches, searchKeymap } from '@codemirror/search'
import { EditorState, type Extension } from '@codemirror/state'
import {
  crosshairCursor,
  drawSelection,
  dropCursor,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
  rectangularSelection,
} from '@codemirror/view'
import { tags as t } from '@lezer/highlight'

const props = defineProps<{ modelValue: string; mode: 'text' | 'md' }>()
const emit = defineEmits<{ 'update:modelValue': [string] }>()
const el = ref<HTMLElement>()
let view: EditorView | null = null

// mono 语法高亮：墨色为主，cyan 标强调，ochre 标代码。替换彩色 defaultHighlightStyle。
const monoHighlight = HighlightStyle.define([
  { tag: t.heading, color: 'var(--reader-ink)', fontWeight: '700' },
  { tag: t.strong, color: 'var(--reader-ink)', fontWeight: '600' },
  { tag: t.emphasis, color: 'var(--reader-ink)', fontStyle: 'italic' },
  { tag: [t.link, t.url], color: 'var(--reader-accent)' },
  { tag: t.list, color: 'var(--reader-accent)' },
  { tag: t.quote, color: 'var(--reader-ink-2)' },
  { tag: t.meta, color: 'var(--reader-ink-2)' },
  { tag: t.monospace, color: 'var(--reader-ink-2)' },
  { tag: [t.keyword, t.atom, t.bool], color: 'var(--reader-accent)' },
])

// CM6 外观：对齐 mockup .prose（卡片式：panel-42 底 + white-14 边 + 12px 圆角 + focus cyan 光晕）
const editorTheme = EditorView.theme({
  '&': { backgroundColor: 'var(--reader-bg)', border: '1px solid var(--reader-border)', borderRadius: '12px', height: '73vh', fontSize: 'var(--prose-size)', color: 'var(--reader-ink)', letterSpacing: '.3px', transition: 'box-shadow .2s,border-color .2s,background .15s' },
  '&.cm-focused': { outline: 'none', borderColor: 'var(--reader-accent)', boxShadow: '0 0 0 3px var(--reader-accent-soft)' },
  '.cm-scroller': { fontFamily: 'var(--prose-font)', lineHeight: 'var(--prose-lh)', borderRadius: '12px' },
  '.cm-content': { caretColor: 'var(--reader-accent)', padding: '18px 22px' },
  '.cm-gutters': { backgroundColor: 'transparent', border: 'none', color: 'var(--reader-ink-2)' },
  '.cm-activeLine': { backgroundColor: 'var(--reader-accent-soft)' },
  '.cm-activeLineGutter': { backgroundColor: 'transparent', color: 'var(--reader-ink)' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground': { backgroundColor: 'var(--sel-bg)' },
})

const editorSetup: Extension[] = [
  lineNumbers(),
  highlightActiveLineGutter(),
  highlightSpecialChars(),
  history(),
  foldGutter(),
  drawSelection(),
  dropCursor(),
  EditorState.allowMultipleSelections.of(true),
  indentOnInput(),
  syntaxHighlighting(monoHighlight),
  bracketMatching(),
  rectangularSelection(),
  crosshairCursor(),
  highlightActiveLine(),
  highlightSelectionMatches(),
  keymap.of([...defaultKeymap, ...searchKeymap, ...historyKeymap, ...foldKeymap]),
]

onMounted(() => {
  if (!el.value) return
  view = new EditorView({
    doc: props.modelValue,
    extensions: [
      editorSetup,
      editorTheme,
      EditorView.lineWrapping,
      // 正文模式纯文本（不高亮）；设定模式 MD 语法高亮
      ...(props.mode === 'md' ? [markdown()] : []),
      EditorView.updateListener.of((u) => {
        if (u.docChanged) emit('update:modelValue', u.state.doc.toString())
      }),
    ],
    parent: el.value,
  })
})

// 外部 modelValue 变（切文件加载）→ 同步；仅当差异时，避免光标跳
watch(
  () => props.modelValue,
  (v) => {
    if (view && v !== view.state.doc.toString()) {
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: v } })
    }
  },
)

/** 选区两侧包裹（粗体 ** / 斜体 * / 代码 `）；无选区时只插前缀，光标停中间 */
function wrapSel(before: string, after: string = before): void {
  if (!view) return
  const sel = view.state.selection.main
  const text = view.state.sliceDoc(sel.from, sel.to)
  const insert = before + text + after
  const anchor = sel.from + before.length
  const head = sel.from + before.length + text.length
  view.dispatch({
    changes: { from: sel.from, to: sel.to, insert },
    selection: { anchor, head },
  })
  view.focus()
}

/** 行首加前缀（标题 # / 列表 - / 引用 >） */
function linePrefix(prefix: string): void {
  if (!view) return
  const sel = view.state.selection.main
  const line = view.state.doc.lineAt(sel.from)
  view.dispatch({
    changes: { from: line.from, to: line.from, insert: prefix },
    selection: { anchor: sel.from + prefix.length, head: sel.to + prefix.length },
  })
  view.focus()
}

// 暴露选区（局部改写取用）+ markdown 格式化（工具栏按钮）
defineExpose({
  getSelection: (): { text: string; from: number; to: number } | null => {
    if (!view) return null
    const sel = view.state.selection.main
    if (sel.from === sel.to) return null
    return { text: view.state.sliceDoc(sel.from, sel.to), from: sel.from, to: sel.to }
  },
  wrapSel,
  linePrefix,
})

onUnmounted(() => view?.destroy())
</script>

<template>
  <div ref="el" class="code-editor"></div>
</template>
