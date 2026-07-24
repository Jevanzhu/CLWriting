<script setup lang="ts">
// Obsidian view-header：面包屑（书名 › 视图）+ 右侧操作位（T0.3 留空，P1+ 放 inline 操作）。
defineProps<{ bookName: string }>()
const hasDesktop = typeof window !== 'undefined' && !!window.clwritingDesktop
</script>

<template>
  <div class="view-header" :class="{ 'is-drag': hasDesktop }">
    <div class="crumbs">
      <span class="crumb">{{ bookName }}</span>
      <span class="crumb-sep">›</span>
      <span class="crumb-current">编辑</span>
    </div>
    <div class="view-actions" />
  </div>
</template>

<style scoped>
.view-header {
  height: 36px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 var(--size-4-3);
  border-bottom: 1px solid var(--background-modifier-border);
  background: var(--background-primary);
}
/* 桌面版：header 空白区可拖动整窗（面包屑/操作位仍可交互） */
.view-header.is-drag {
  -webkit-app-region: drag;
}
.view-header.is-drag .crumbs,
.view-header.is-drag .view-actions {
  -webkit-app-region: no-drag;
}
.crumbs {
  font-size: 13px;
  color: var(--text-faint);
}
.crumb-current {
  color: var(--text-normal);
}
.crumb-sep {
  margin: 0 6px;
}
</style>
