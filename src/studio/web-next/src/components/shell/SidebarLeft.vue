<script setup lang="ts">
import { FolderTree, Search, Trash2 } from 'lucide-vue-next'
import { useWorkspaceStore } from '../../stores/workspace'
import ChapterTreePanel from '../panels/ChapterTreePanel.vue'
import SearchPanel from '../panels/SearchPanel.vue'
import TrashPanel from '../panels/TrashPanel.vue'

// 左侧栏：顶部面板切换（树/搜索/回收站）+ 活动面板。
defineProps<{ bookName: string }>()
const ws = useWorkspaceStore()
</script>

<template>
  <div class="sidebar-left">
    <div class="left-tabs">
      <button
        class="left-tab"
        :class="{ active: ws.leftPanel === 'tree' }"
        title="章节树"
        @click="ws.setLeftPanel('tree')"
      >
        <FolderTree :size="16" />
      </button>
      <button
        class="left-tab"
        :class="{ active: ws.leftPanel === 'search' }"
        title="搜索"
        @click="ws.setLeftPanel('search')"
      >
        <Search :size="16" />
      </button>
      <button
        class="left-tab"
        :class="{ active: ws.leftPanel === 'trash' }"
        title="回收站"
        @click="ws.setLeftPanel('trash')"
      >
        <Trash2 :size="16" />
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
  display: flex;
  gap: 2px;
  padding: var(--size-4-2) var(--size-4-2) 0;
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
}
.left-tab:hover {
  background: var(--background-modifier-hover);
  color: var(--text-muted);
}
.left-tab.active {
  background: var(--background-modifier-active-hover);
  color: var(--text-accent);
}
.left-body {
  flex: 1;
  min-height: 0;
  overflow: auto;
}
</style>
