<script setup lang="ts">
// Obsidian view-header：面包屑（书名 › 视图）。收起右栏/专注入口已移至 TabBar。
import { computed } from 'vue'
import { useWorkspaceStore } from '../../stores/workspace'

defineProps<{ bookName: string }>()
const ws = useWorkspaceStore()
const hasDesktop = typeof window !== 'undefined' && !!window.clwritingDesktop

// 面包屑当前视图名：按 activeView 映射中文，切视图跟随（ribbon 点哪 Crumb 显哪）。
const VIEW_LABELS: Record<string, string> = {
  editor: '编辑',
  workbench: 'AI 工作台',
  onboard: '开书',
  overview: '总览',
  relations: '关系图',
  learn: '文风收割',
  style: '文风',
  audit: '事件审计',
}
const viewLabel = computed(() => VIEW_LABELS[ws.activeView] ?? '编辑')
</script>

<template>
  <div class="view-header" :class="{ 'is-drag': hasDesktop }">
    <div class="crumbs">
      <span class="crumb">{{ bookName }}</span>
      <span class="crumb-sep">›</span>
      <span class="crumb-current">{{ viewLabel }}</span>
    </div>
  </div>
</template>

<style scoped>
.view-header {
  height: 36px;
  display: flex;
  align-items: center;
  padding: 0 var(--size-4-3);
  border-bottom: 1px solid var(--background-modifier-border);
  background: var(--background-primary);
}
.view-header.is-drag {
  -webkit-app-region: drag;
}
.crumbs {
  font-size: var(--font-size-m);
  color: var(--text-faint);
  -webkit-app-region: no-drag;
}
.crumb-current {
  color: var(--text-normal);
}
.crumb-sep {
  margin: 0 6px;
}
</style>
