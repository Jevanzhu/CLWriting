<script setup lang="ts">
// 多标签栏（细案 T1.3）：章名 + dirty 圆点 + 关闭钮；点击切换、中键关闭。
import { computed } from 'vue'
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
  align-items: flex-end;
  gap: 2px;
  padding: var(--size-4-2) var(--size-4-2) 0;
  background: var(--tab-container-background);
  border-bottom: 1px solid var(--background-modifier-border);
  overflow-x: auto;
  overflow-y: hidden;  /* 仅横向滚动；杜绝 overflow-x:auto 副作用把 overflow-y 提升为 auto 而触发竖向滚动条（右侧灰条） */
}
/* 桌面版：tab 之间的空白与右侧未占满区可拖动整窗（tab 本身可点） */
.tabbar.is-drag {
  -webkit-app-region: drag;
}
/* 桌面版 + 左栏关闭（含专注模式）：ws-main 左移到交通灯区，首个 tab 右避让交通灯
 * （与 SidebarLeft left-tabs 的 padding-left:52 一致，避到 x:96；该区仍属 is-drag 可拖窗） */
.tabbar.avoid-traffic {
  padding-left: 52px;
}
/* Obsidian 风格 tab（变量名对齐官方公开 CSS 变量，值为本项目设定）：
 * 顶部圆角、间距分隔（无竖线）；活跃 tab 靠背景色差+圆角体现，底部留 1px 给横线分隔。
 * 不向下溢出（无 margin-bottom 负值）——避免叠加 overflow-x:auto 副作用触发竖向滚动条。 */
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
  border: none;
  background: transparent;
  color: var(--text-faint);
  font-size: 16px;
  line-height: 1;
  cursor: pointer;
  padding: 0 2px;
  border-radius: var(--radius-s);
  opacity: 0;
  transition: opacity 0.12s ease;
}
.tab:hover .close,
.tab.active .close {
  opacity: 1;
}
.close:hover {
  color: var(--text-error);
  background: var(--background-modifier-hover);
}
</style>
