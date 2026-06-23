<script setup lang="ts">
import { ref, onMounted, onUnmounted, watch } from 'vue'
import { basicSetup, EditorView } from 'codemirror'
import { markdown } from '@codemirror/lang-markdown'

const props = defineProps<{ modelValue: string; mode: 'text' | 'md' }>()
const emit = defineEmits<{ 'update:modelValue': [string] }>()
const el = ref<HTMLElement>()
let view: EditorView | null = null

onMounted(() => {
  if (!el.value) return
  view = new EditorView({
    doc: props.modelValue,
    extensions: [
      basicSetup,
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
  border: 1px solid #e5e7eb;
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
