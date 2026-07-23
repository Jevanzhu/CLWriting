<script setup lang="ts">
// 右侧栏：写作信息（T2.2）+ 上下文速查（T2.3）。
import WritingInfoPanel from '../panels/WritingInfoPanel.vue'
import ContextQuickPanel from '../panels/ContextQuickPanel.vue'
defineProps<{ bookName: string }>()
</script>

<template>
  <div class="sidebar-right">
    <WritingInfoPanel :book-name="bookName" />
    <ContextQuickPanel :book-name="bookName" />
  </div>
</template>

<style scoped>
.sidebar-right {
  padding: var(--size-4-3);
  display: flex;
  flex-direction: column;
  gap: var(--size-4-4);
  height: 100%;
  overflow: auto;
}
.side-section {
  display: flex;
  flex-direction: column;
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
