<script setup lang="ts">
// Obsidian view-header：面包屑（书名 › 视图）+ 右侧操作位（专注模式入口）。
import { computed } from 'vue'
import { Focus } from 'lucide-vue-next'
import { useWorkspaceStore } from '../../stores/workspace'

defineProps<{ bookName: string }>()
const ws = useWorkspaceStore()
const hasDesktop = typeof window !== 'undefined' && !!window.clwritingDesktop

// 面包屑当前视图名：按 activeView 映射中文，切视图跟随（ribbon 点哪 Crumb 显哪）。
const VIEW_LABELS: Record<string, string> = {
  editor: '编辑',
  workbench: '工作台',
  onboard: '开书',
  overview: '总览',
  rhythm: '节奏',
  relations: '关系图',
  learn: '文风收割',
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
    <div class="view-actions">
      <button
        class="action-btn"
        :class="{ active: ws.focusMode }"
        :title="ws.focusMode ? '退出专注（⌘⇧F）' : '专注模式（⌘⇧F）'"
        @click="ws.toggleFocus()"
      >
        <Focus :size="16" />
      </button>
    </div>
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
  font-size: var(--font-size-m);
  color: var(--text-faint);
}
.crumb-current {
  color: var(--text-normal);
}
.crumb-sep {
  margin: 0 6px;
}
.action-btn {
  width: 28px;
  height: 28px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: none;
  background: transparent;
  color: var(--text-faint);
  border-radius: var(--radius-s);
  cursor: pointer;
  -webkit-app-region: no-drag;
}
.action-btn:hover {
  background: var(--background-modifier-hover);
  color: var(--text-muted);
}
.action-btn.active {
  background: var(--background-modifier-active-hover);
  color: var(--text-accent);
}
</style>
