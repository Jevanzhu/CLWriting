<script setup lang="ts">
import { PanelLeftClose } from 'lucide-vue-next'
import { useWorkspaceStore } from '../../stores/workspace'
import ChapterTreePanel from '../panels/ChapterTreePanel.vue'
import SearchPanel from '../panels/SearchPanel.vue'
import TrashPanel from '../panels/TrashPanel.vue'

// 左侧栏：顶部面板切换（树/搜索/回收站）+ 活动面板。
// 桌面版：顶部横排按钮与交通灯同一排（在交通灯右侧），右移让出交通灯宽度，不下移。
defineProps<{ bookName: string }>()
const ws = useWorkspaceStore()
const hasDesktop = typeof window !== 'undefined' && !!window.clwritingDesktop
</script>

<template>
  <div class="sidebar-left" :class="{ 'has-traffic': hasDesktop }">
    <div class="left-tabs" :class="{ 'is-drag': hasDesktop }">
      <button
        class="left-tab collapse-left"
        data-tip="收起左栏" data-tip-dir="bottom"
        @click="ws.toggleLeft()"
      >
        <PanelLeftClose :size="16" />
      </button>
    </div>
    <div class="left-body">
      <ChapterTreePanel v-if="ws.leftPanel === 'tree'" :book-name="bookName" />
      <SearchPanel v-else-if="ws.leftPanel === 'search'" :book-name="bookName" />
      <TrashPanel v-else-if="ws.leftPanel === 'trash'" :book-name="bookName" />
    </div>
  </div>
</template>

<style scoped>
.sidebar-left {
  height: 100%;
  display: flex;
  flex-direction: column;
}
.left-tabs {
  flex-shrink: 0;
  height: var(--size-tabbar);
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 0 var(--size-4-2);
  border-bottom: 1px solid var(--background-modifier-border);
}
/* 桌面版：横排按钮与交通灯同排，右移让出交通灯宽度（交通灯约占窗口左上 x:13-65） */
.sidebar-left.has-traffic .left-tabs {
  padding-left: 52px;
}
/* 桌面版：顶部横排按钮间的空白（含交通灯避让区）可拖动整窗 */
.left-tabs.is-drag {
  -webkit-app-region: drag;
}
.left-tab {
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
.left-tab:hover {
  background: var(--background-modifier-hover);
  color: var(--text-muted);
}
.left-tab.active {
  background: var(--background-modifier-active-hover);
  color: var(--text-accent);
}
/* 收起左栏：推到 left-tabs 最右（左栏右边缘，对称右栏的 PanelRightClose） */
.left-tab.collapse-left {
  margin-left: auto;
}
.left-body {
  flex: 1;
  min-height: 0;
  overflow: auto;
}
</style>
