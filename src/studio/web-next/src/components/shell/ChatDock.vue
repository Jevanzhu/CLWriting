<script setup lang="ts">
/**
 * 底部 dock（方案 B）：编辑器写稿时随手问一句。
 * 挂载点在 WorkspaceShell 的 main.ws-main 内部（ws-view 之后），
 * 只占主区域宽度，左右侧栏保持全高。
 */
import { ref } from 'vue'
import { PanelBottom, ChevronDown, ChevronUp } from 'lucide-vue-next'
import ChatPanel from '../panels/ChatPanel.vue'

defineProps<{
  bookName: string
  currentChapter?: number
}>()

const expanded = ref(false)

function toggle(): void {
  expanded.value = !expanded.value
}
</script>

<template>
  <div class="chat-dock" :class="{ expanded }">
    <!-- 折叠态：一行入口条 -->
    <button v-if="!expanded" class="dock-toggle" @click="toggle">
      <PanelBottom :size="14" />
      <span>对话助手</span>
      <ChevronUp :size="14" />
    </button>

    <!-- 展开态：完整面板 -->
    <template v-else>
      <button class="dock-toggle dock-toggle-open" @click="toggle">
        <PanelBottom :size="14" />
        <span>对话助手</span>
        <ChevronDown :size="14" />
      </button>
      <div class="dock-content">
        <ChatPanel :book-name="bookName" :current-chapter="currentChapter" />
      </div>
    </template>
  </div>
</template>

<style scoped>
.chat-dock {
  flex-shrink: 0;
  border-top: 1px solid var(--border-default);
  background: var(--background-primary);
  display: flex;
  flex-direction: column;
}
.chat-dock.expanded {
  height: 280px;
  min-height: 0;
}
.dock-toggle {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px var(--size-3-2);
  background: var(--background-secondary);
  border: none;
  color: var(--text-muted);
  font-size: var(--font-size-s);
  cursor: pointer;
  transition: var(--dur-fast) var(--ease-out);
  width: 100%;
  text-align: left;
}
.dock-toggle:hover {
  color: var(--text-default);
}
.dock-toggle-open {
  border-bottom: 1px solid var(--border-default);
}
.dock-content {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
</style>
