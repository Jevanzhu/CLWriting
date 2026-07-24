<script setup lang="ts">
import { useRouter } from 'vue-router'
import {
  FolderTree,
  Search,
  LayoutGrid,
  Wrench,
  Compass,
  Download,
  Library,
  Settings,
  Sun,
  Moon,
} from 'lucide-vue-next'
import { useTheme } from '../../composables/useTheme'
import { useWorkspaceStore } from '../../stores/workspace'
import { useUiStore } from '../../stores/ui'

// Ribbon（~44px 图标列）：上部 章节树/搜索/总览/工作台/开书；底部 导出/书架/设置/亮暗。
// macOS 交通灯占顶部 ~28px：桌面版顶部留白 40px（图标下移避让）+ 顶部空白可拖动窗口（参考 Obsidian）。
const router = useRouter()
const { theme, toggle } = useTheme()
const ws = useWorkspaceStore()
const ui = useUiStore()
const hasDesktop = typeof window !== 'undefined' && !!window.clwritingDesktop
</script>

<template>
  <div class="ribbon" :class="{ 'has-traffic': hasDesktop }">
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
      <button
        class="rbtn"
        :class="{ on: ws.activeView === 'overview' }"
        title="总览（书况 / 进度 / 卷纲 / 热力）"
        @click="ws.setActiveView('overview')"
      >
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
      <button class="rbtn" title="导出定稿" @click="ui.openExport()">
        <Download :size="20" />
      </button>
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
  position: relative;
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  align-items: center;
  padding: var(--size-4-2) 0;
  background: var(--background-secondary);
  border-right: 1px solid var(--background-modifier-border);
}
/* 桌面版：顶部留白避交通灯（= 顶部带高度）+ 可拖动窗口；避让区底横线与左栏/主区/右栏顶部带对齐成一条 */
.ribbon.has-traffic {
  padding-top: var(--size-tabbar);
  border-right: none;
}
.ribbon.has-traffic::before {
  content: '';
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  height: var(--size-tabbar);
  -webkit-app-region: drag;
  border-bottom: 1px solid var(--background-modifier-border);
}
/* 右侧分界线：从顶部带横线下方开始到底，交通灯区无竖线（ribbon/sidebar 同色融合） */
.ribbon.has-traffic::after {
  content: '';
  position: absolute;
  right: 0;
  top: var(--size-tabbar);
  bottom: 0;
  width: 1px;
  background: var(--background-modifier-border);
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
