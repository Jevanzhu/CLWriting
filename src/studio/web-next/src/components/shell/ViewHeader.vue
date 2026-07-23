<script setup lang="ts">
// Obsidian view-header：面包屑（书名 › 视图）+ 右侧操作位（T0.3 留空，P1+ 放 inline 操作）。
defineProps<{ bookName: string }>()
</script>

<template>
  <div class="view-header">
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
