<script setup lang="ts">
// CodeMirror 6 封装（细案 §5 editor/CmHost.vue）：Obsidian 风格正文编辑器。
// 无行号/无卡片边框、lineWrapping、正文字体（--prose-* 偏好）；md 模式加 markdown() 高亮。
import { ref, onMounted, onUnmounted, watch } from 'vue'
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import { markdown } from '@codemirror/lang-markdown'
import {
  HighlightStyle,
  bracketMatching,
  foldKeymap,
  indentOnInput,
  syntaxHighlighting,
} from '@codemirror/language'
import { highlightSelectionMatches, searchKeymap } from '@codemirror/search'
import { EditorState, type Extension } from '@codemirror/state'
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

const props = defineProps<{ modelValue: string; mode: 'text' | 'md'; readonly?: boolean }>()
const emit = defineEmits<{ 'update:modelValue': [string] }>()
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
  '.cm-content': { caretColor: 'var(--text-accent)', padding: '0', maxWidth: '720px', margin: '0 auto' },
  '.cm-line': { padding: '0' },
  '.cm-activeLine': { backgroundColor: 'var(--background-modifier-hover)' },
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
      EditorState.readOnly.of(props.readonly ?? false),
      ...(props.mode === 'md' ? [markdown()] : []),
      EditorView.updateListener.of((u) => {
        if (u.docChanged) emit('update:modelValue', u.state.doc.toString())
      }),
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
</style>
