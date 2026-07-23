<script setup lang="ts">
// T0.3 占位；P1 落章节树（ChapterTreePanel：语义树 卷›章 + 六态角标 + 右键菜单）。
</script>

<template>
  <div class="sidebar-left">
    <div class="side-title">章节树</div>
    <div class="side-hint">P1 实现：语义树（卷 › 章 + 六态角标）+ Obsidian 式右键菜单</div>
  </div>
</template>

<style scoped>
.sidebar-left {
  padding: var(--size-4-2) var(--size-4-3);
}
.side-title {
  font-size: 11px;
  font-weight: 600;
  color: var(--text-faint);
  text-transform: uppercase;
  letter-spacing: 0.05em;
  margin-bottom: var(--size-4-2);
}
.side-hint {
  font-size: 12px;
  color: var(--text-faint);
  line-height: 1.6;
}
</style>
