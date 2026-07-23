<script setup lang="ts">
import { useRouter } from 'vue-router'
import {
  FolderTree,
  Search,
  LayoutGrid,
  Wrench,
  Compass,
  Library,
  Settings,
  Sun,
  Moon,
} from 'lucide-vue-next'
import { useTheme } from '../../composables/useTheme'
import { useWorkspaceStore } from '../../stores/workspace'
import { useUiStore } from '../../stores/ui'

// Ribbon（~44px 图标列）：上部 章节树/搜索/总览/工作台；底部 书架/设置/亮暗。
// 总览（P4）/工作台（P3）待落仍置灰。
const router = useRouter()
const { theme, toggle } = useTheme()
const ws = useWorkspaceStore()
const ui = useUiStore()
</script>

<template>
  <div class="ribbon">
    <div class="ribbon-group">
      <button
        class="rbtn"
        :class="{ on: ws.leftOpen }"
        title="章节树（⌘B）"
        @click="ws.toggleLeft()"
      >
        <FolderTree :size="20" />
      </button>
      <button
        class="rbtn"
        :class="{ on: ws.leftPanel === 'search' }"
        title="搜索"
        @click="ws.setLeftPanel('search')"
      >
        <Search :size="20" />
      </button>
      <div class="ribbon-sep" />
      <button class="rbtn" title="总览视图（待 P4）" disabled>
        <LayoutGrid :size="20" />
      </button>
      <button
        class="rbtn"
        :class="{ on: ws.activeView === 'workbench' }"
        title="工作台（AI 写作）"
        @click="ws.setActiveView('workbench')"
      >
        <Wrench :size="20" />
      </button>
      <button
        class="rbtn"
        :class="{ on: ws.activeView === 'onboard' }"
        title="开书对话（分步生成设定）"
        @click="ws.setActiveView('onboard')"
      >
        <Compass :size="20" />
      </button>
    </div>

    <div class="ribbon-group">
      <button class="rbtn" title="返回书架" @click="router.push('/shelf')">
        <Library :size="20" />
      </button>
      <button class="rbtn" title="设置（⌘,）" @click="ui.openSettings()">
        <Settings :size="20" />
      </button>
      <button
        class="rbtn"
        :title="theme === 'dark' ? '切到亮色' : '切到暗色'"
        @click="toggle()"
      >
        <Moon v-if="theme === 'light'" :size="20" />
        <Sun v-else :size="20" />
      </button>
    </div>
  </div>
</template>

<style scoped>
.ribbon {
  width: var(--size-ribbon);
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  align-items: center;
  padding: var(--size-4-2) 0;
  background: var(--background-secondary);
  border-right: 1px solid var(--background-modifier-border);
}
.ribbon-group {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
}
.rbtn {
  width: 32px;
  height: 32px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: none;
  background: transparent;
  color: var(--text-muted);
  border-radius: var(--radius-s);
  cursor: pointer;
}
.rbtn:hover:not(:disabled) {
  background: var(--background-modifier-hover);
  color: var(--text-normal);
}
.rbtn.on {
  color: var(--text-accent);
}
.rbtn:disabled {
  opacity: 0.35;
  cursor: default;
}
.ribbon-sep {
  width: 22px;
  height: 1px;
  background: var(--background-modifier-border);
  margin: 4px 0;
}
</style>
