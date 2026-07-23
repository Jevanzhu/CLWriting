<script setup lang="ts">
import { useRouter } from 'vue-router'
import {
  FolderTree,
  Search,
  LayoutGrid,
  Wrench,
  Library,
  Settings,
  Sun,
  Moon,
} from 'lucide-vue-next'
import { useTheme } from '../../composables/useTheme'
import { useWorkspaceStore } from '../../stores/workspace'

// Ribbon（~44px 图标列）：上部 章节树/搜索/总览/工作台；底部 书架/设置/亮暗。
// 未实现的入口（搜索/总览/工作台/设置）置灰，标题标注待办阶段。
const router = useRouter()
const { theme, toggle } = useTheme()
const ws = useWorkspaceStore()
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
      <button class="rbtn" title="搜索（待 P1）" disabled>
        <Search :size="20" />
      </button>
      <div class="ribbon-sep" />
      <button class="rbtn" title="总览视图（待 P4）" disabled>
        <LayoutGrid :size="20" />
      </button>
      <button class="rbtn" title="工作台视图（待 P3）" disabled>
        <Wrench :size="20" />
      </button>
    </div>

    <div class="ribbon-group">
      <button class="rbtn" title="返回书架" @click="router.push('/shelf')">
        <Library :size="20" />
      </button>
      <button class="rbtn" title="设置（待 T2.4）" disabled>
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
