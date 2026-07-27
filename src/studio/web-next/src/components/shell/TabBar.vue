<script setup lang="ts">
// 多标签栏（细案 T1.3）：章名 + dirty 圆点 + 关闭钮；点击切换、中键关闭。
// 右侧固定收起右栏 + 专注入口（独立区域，不随 tabs 横滚）。
import { computed } from 'vue'
import { X, Focus, PanelRight, PanelLeft } from 'lucide-vue-next'
import { useWorkspaceStore } from '../../stores/workspace'
import { useDocStore } from '../../stores/doc'
import { useTreeStore } from '../../stores/tree'

defineProps<{ bookName: string }>()
const ws = useWorkspaceStore()
const doc = useDocStore()
const tree = useTreeStore()
const hasDesktop = typeof window !== 'undefined' && !!window.clwritingDesktop
// 左栏可见性（含专注模式覆盖）：关闭时 ws-main 左移到交通灯区，首个 tab 需避让
const leftVisible = computed(() => ws.leftOpen && !ws.focusMode)

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
  <div class="tabbar" :class="{ 'is-drag': hasDesktop, 'avoid-traffic': hasDesktop && !leftVisible }">
    <div v-if="!ws.leftOpen" class="tabbar-actions-left">
      <button
        class="tb-btn"
        data-tip="展开左栏" data-tip-dir="bottom"
        @click="ws.toggleLeft()"
      >
        <PanelLeft :size="16" />
      </button>
    </div>
    <div class="tabbar-scroll">
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
        <button class="close" data-tip="关闭" data-tip-dir="bottom" @click.stop="ws.requestClose(t.id)"><X :size="14" /></button>
      </div>
    </div>
    <div class="tabbar-actions">
      <button
        class="tb-btn"
        :class="{ active: ws.focusMode }"
        :data-tip="ws.focusMode ? '退出专注（⌘⇧F）' : '专注模式（⌘⇧F）'"
        data-tip-dir="bottom"
        @click="ws.toggleFocus()"
      >
        <Focus :size="16" />
      </button>
      <button
        v-show="!ws.rightOpen"
        class="tb-btn"
        data-tip="展开右栏" data-tip-dir="bottom"
        @click="ws.toggleRight()"
      >
        <PanelRight :size="16" />
      </button>
    </div>
  </div>
</template>

<style scoped>
.tabbar {
  min-height: var(--size-tabbar);
  display: flex;
  align-items: stretch;
  background: var(--tab-container-background);
  border-bottom: 1px solid var(--background-modifier-border);
  overflow: hidden;
}
/* 桌面版：空白区可拖动整窗（tab / 按钮本身可点） */
.tabbar.is-drag {
  -webkit-app-region: drag;
}
/* 桌面版交通灯避让：tabbar-actions-left 存在时由它避让（左栏关闭）；
   不存在时（专注模式）由 tabbar-scroll 自身避让 */
.tabbar.avoid-traffic:not(:has(.tabbar-actions-left)) .tabbar-scroll {
  padding-left: 52px;
}
/* tabs 滚动区（独立 overflow-x，右侧按钮不随之滚走） */
.tabbar-scroll {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: flex-end;
  gap: 2px;
  padding: var(--size-4-2) var(--size-4-2) 0;
  overflow-x: auto;
  overflow-y: hidden;
}
/* Obsidian 风格 tab（变量名对齐官方公开 CSS 变量，值为本项目设定） */
.tab {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 0 var(--size-4-3);
  height: calc(var(--size-tabbar) - var(--size-4-2) - 1px);
  font-size: var(--tab-font-size);
  color: var(--tab-text-color);
  border-radius: var(--tab-radius) var(--tab-radius) 0 0;
  cursor: pointer;
  white-space: nowrap;
  flex-shrink: 0;
  -webkit-app-region: no-drag;
}
.tab:hover:not(.active) {
  background: var(--background-modifier-hover);
}
.tab.active {
  color: var(--tab-text-color-active);
  background: var(--tab-background-active);
  border-radius: var(--tab-radius-active) var(--tab-radius-active) 0 0;
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
/* 关闭钮：仅 hover/活跃时显现（Obsidian 惯例） */
.close {
  display: flex;
  align-items: center;
  justify-content: center;
  border: none;
  background: transparent;
  color: var(--text-faint);
  cursor: pointer;
  padding: 2px;
  border-radius: var(--radius-s);
  opacity: 0;
  transition: opacity var(--dur-fast) var(--ease-out);
}
.tab:hover .close,
.tab.active .close {
  opacity: 1;
}
.close:hover {
  color: var(--text-error);
  background: var(--background-modifier-hover);
}
/* 左侧固定按钮区（展开左栏）——左栏关闭时出现，桌面版避让交通灯 */
.tabbar-actions-left {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  padding-left: var(--size-4-2);
}
.tabbar-actions-left .tb-btn {
  -webkit-app-region: no-drag;
}
.tabbar.avoid-traffic .tabbar-actions-left {
  padding-left: 52px;
}
/* 右侧固定按钮区（展开右栏 + 专注）——独立于 tabs 滚动区，始终钉在最右 */
.tabbar-actions {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 0 var(--size-4-2);
}
.tabbar-actions .tb-btn {
  -webkit-app-region: no-drag;
}
.tb-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border: none;
  background: transparent;
  color: var(--text-faint);
  border-radius: var(--radius-s);
  cursor: pointer;
}
.tb-btn:hover {
  background: var(--background-modifier-hover);
  color: var(--text-normal);
}
.tb-btn.active {
  color: var(--text-accent);
}
</style>
