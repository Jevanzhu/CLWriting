<script setup lang="ts">
import { computed, watch } from 'vue'
import { useRoute } from 'vue-router'
import WorkspaceShell from '../components/shell/WorkspaceShell.vue'
import EditorView from '../views/EditorView.vue'
import WorkbenchView from '../views/WorkbenchView.vue'
import { useHeartbeat } from '../composables/useHeartbeat'
import { useSse } from '../composables/useSse'
import { useDocStore } from '../stores/doc'
import { useWorkspaceStore } from '../stores/workspace'
import { useTreeStore } from '../stores/tree'

// 工作区视图（/book/:name）：套 Obsidian 外壳 + 进书心跳 + 编辑视图（消费活动 tab docId）。
// bookName 走 computed：同组件复用切书（/book/A→/book/B）时 bookName/心跳/doc 缓存/tabs 跟随更新。
const route = useRoute()
const bookName = computed(() => String(route.params.name))
useHeartbeat(() => bookName.value)
useSse(() => bookName.value)

const doc = useDocStore()
const ws = useWorkspaceStore()
const tree = useTreeStore()
// 切书：同步 doc 缓存 + 载入持久化 tabs
watch(bookName, (n) => {
  doc.setBook(n)
  ws.setBook(n)
}, { immediate: true })
// tree 加载后校验 tabs（剔除失效 docId）
watch(
  () => tree.byDocId.size,
  () => ws.validate(new Set(tree.byDocId.keys())),
)
</script>

<template>
  <WorkspaceShell :book-name="bookName">
    <EditorView v-if="ws.activeView === 'editor'" :doc-id="ws.activeDocId" />
    <WorkbenchView v-else :book-name="bookName" />
  </WorkspaceShell>
</template>
