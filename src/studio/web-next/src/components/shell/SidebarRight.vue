<script setup lang="ts">
// 右侧栏：顶部空带（对齐 tabbar 高度，桌面版可拖窗）+ 写作信息（T2.2）+ 上下文速查（T2.3）。
import WritingInfoPanel from '../panels/WritingInfoPanel.vue'
import ContextQuickPanel from '../panels/ContextQuickPanel.vue'
defineProps<{ bookName: string }>()
const hasDesktop = typeof window !== 'undefined' && !!window.clwritingDesktop
</script>

<template>
  <div class="sidebar-right">
    <div class="right-topbar" :class="{ 'is-drag': hasDesktop }" />
    <div class="right-body">
      <WritingInfoPanel :book-name="bookName" />
      <ContextQuickPanel :book-name="bookName" />
    </div>
  </div>
</template>

<style scoped>
.sidebar-right {
  display: flex;
  flex-direction: column;
  height: 100%;
  overflow: hidden;
  background: var(--background-secondary);
}
/* 顶部空带：高度对齐 tabbar（--size-tabbar），底部横线与左栏/主区顶部带对齐；桌面版可拖窗 */
.right-topbar {
  flex-shrink: 0;
  height: var(--size-tabbar);
  border-bottom: 1px solid var(--background-modifier-border);
  background: var(--background-secondary);
}
.right-topbar.is-drag {
  -webkit-app-region: drag;
}
.right-body {
  flex: 1;
  overflow: auto;
  padding: var(--size-4-3);
  display: flex;
  flex-direction: column;
  gap: var(--size-4-4);
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
