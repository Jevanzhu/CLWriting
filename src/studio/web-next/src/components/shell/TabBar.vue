<script setup lang="ts">
// 多标签栏（细案 T1.3）：章名 + dirty 圆点 + 关闭钮；点击切换、中键关闭。
import { useWorkspaceStore } from '../../stores/workspace'
import { useDocStore } from '../../stores/doc'
import { useTreeStore } from '../../stores/tree'

defineProps<{ bookName: string }>()
const ws = useWorkspaceStore()
const doc = useDocStore()
const tree = useTreeStore()

function title(docId: string): string {
  return doc.get(docId)?.name ?? tree.byDocId.get(docId)?.name ?? '未命名'
}
function dirty(docId: string): boolean {
  return doc.get(docId)?.dirty ?? false
}
// 中键关闭（Obsidian/浏览器惯例）
function onAux(e: MouseEvent, id: string): void {
  if (e.button === 1) {
    e.preventDefault()
    ws.requestClose(id)
  }
}
</script>

<template>
  <div class="tabbar">
    <div
      v-for="t in ws.tabs"
      :key="t.id"
      class="tab"
      :class="{ active: t.id === ws.activeTabId }"
      @click="ws.activateTab(t.id)"
      @auxclick="onAux($event, t.id)"
    >
      <span class="dot" :class="{ dirty: dirty(t.docId) }"></span>
      <span class="title">{{ title(t.docId) }}</span>
      <button class="close" title="关闭" @click.stop="ws.requestClose(t.id)">×</button>
    </div>
  </div>
</template>

<style scoped>
.tabbar {
  min-height: var(--size-tabbar);
  display: flex;
  align-items: stretch;
  padding-left: var(--size-4-2);
  background: var(--background-secondary);
  border-bottom: 1px solid var(--background-modifier-border);
  overflow-x: auto;
}
.tab {
  display: flex;
  align-items: center;
  gap: var(--size-4-1);
  padding: 0 var(--size-4-2) 0 var(--size-4-3);
  font-size: 13px;
  color: var(--text-muted);
  border-right: 1px solid var(--background-modifier-border);
  cursor: pointer;
  white-space: nowrap;
  flex-shrink: 0;
}
.tab:hover {
  background: var(--background-modifier-hover);
}
.tab.active {
  color: var(--text-normal);
  background: var(--background-primary);
}
.dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: transparent;
  flex-shrink: 0;
}
.dot.dirty {
  background: var(--text-accent);
}
.title {
  max-width: 160px;
  overflow: hidden;
  text-overflow: ellipsis;
}
.close {
  border: none;
  background: transparent;
  color: var(--text-faint);
  font-size: 16px;
  line-height: 1;
  cursor: pointer;
  padding: 0 2px;
  border-radius: var(--radius-s);
}
.close:hover {
  color: var(--text-error);
  background: var(--background-modifier-hover);
}
</style>
