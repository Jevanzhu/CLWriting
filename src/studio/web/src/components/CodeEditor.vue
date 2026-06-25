<script setup lang="ts">
import { ref, onMounted, onUnmounted, watch } from 'vue'
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import { markdown } from '@codemirror/lang-markdown'
import {
  bracketMatching,
  defaultHighlightStyle,
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

const props = defineProps<{ modelValue: string; mode: 'text' | 'md' }>()
const emit = defineEmits<{ 'update:modelValue': [string] }>()
const el = ref<HTMLElement>()
let view: EditorView | null = null

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
  syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
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

// 暴露选区供局部改写取用
defineExpose({
  getSelection: (): { text: string; from: number; to: number } | null => {
    if (!view) return null
    const sel = view.state.selection.main
    if (sel.from === sel.to) return null
    return { text: view.state.sliceDoc(sel.from, sel.to), from: sel.from, to: sel.to }
  },
})

onUnmounted(() => view?.destroy())
</script>

<template>
  <div ref="el" class="code-editor"></div>
</template>

<style scoped>
.code-editor {
  border: 1px solid var(--border);
  border-radius: 6px;
  height: 62vh;
  overflow: auto;
  font-size: 14px;
  text-align: left;
}
.code-editor :deep(.cm-content) {
  font-family: ui-monospace, 'SF Mono', Menlo, monospace;
}
.code-editor :deep(.cm-focused) {
  outline: none;
}
</style>
