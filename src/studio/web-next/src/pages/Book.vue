<script setup lang="ts">
import { useRoute } from 'vue-router'
import WorkspaceShell from '../components/shell/WorkspaceShell.vue'

// 工作区视图（/book/:name）：套 Obsidian 外壳；正文区占位，P1 落编辑视图（inline title + CodeMirror）。
const route = useRoute()
const bookName = String(route.params.name)
</script>

<template>
  <WorkspaceShell :book-name="bookName">
    <div class="book-empty">
      <p>选择左侧章节开始写作。</p>
      <p class="sub">章节树与编辑器将于 P1 提供。</p>
    </div>
  </WorkspaceShell>
</template>

<style scoped>
.book-empty {
  height: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  color: var(--text-faint);
  font-size: 14px;
}
.sub {
  margin-top: var(--size-4-2);
  font-size: 12px;
}
</style>
