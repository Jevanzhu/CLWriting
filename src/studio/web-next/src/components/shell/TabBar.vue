<script setup lang="ts">
// T0.3 单 tab 占位（书名）；T0.5 落多开/切换/关闭/dirty 圆点/未保存关闭确认。
defineProps<{ bookName: string }>()
</script>

<template>
  <div class="tabbar">
    <div class="tab active">{{ bookName }}</div>
  </div>
</template>

<style scoped>
.tabbar {
  height: var(--size-tabbar);
  display: flex;
  align-items: stretch;
  padding-left: var(--size-4-2);
  background: var(--background-secondary);
  border-bottom: 1px solid var(--background-modifier-border);
}
.tab {
  display: flex;
  align-items: center;
  padding: 0 var(--size-4-3);
  font-size: 13px;
  color: var(--text-muted);
  border-right: 1px solid var(--background-modifier-border);
  cursor: pointer;
}
.tab.active {
  color: var(--text-normal);
  background: var(--background-primary);
}
</style>
