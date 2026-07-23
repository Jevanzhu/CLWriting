<script setup lang="ts">
// 状态栏：左 CLI 连接态（useHeartbeat serverOnline）；右 主题名。T0.4 接心跳；字数/保存态随 P2 加。
import { useTheme } from '../../composables/useTheme'
import { serverOnline } from '../../composables/useHeartbeat'
defineProps<{ bookName: string }>()
const { themeName } = useTheme()
</script>

<template>
  <div class="statusbar">
    <div class="status-left">
      <span class="status-dot" :class="{ off: !serverOnline }" />
      <span>{{ serverOnline ? 'Claude CLI 已连接' : 'CLI 连接中断' }}</span>
    </div>
    <div class="status-right">
      <span>{{ themeName() }}</span>
    </div>
  </div>
</template>

<style scoped>
.statusbar {
  height: var(--size-statusbar);
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 var(--size-4-3);
  background: var(--background-secondary);
  border-top: 1px solid var(--background-modifier-border);
  font-size: 11px;
  color: var(--text-muted);
}
.status-left {
  display: flex;
  align-items: center;
  gap: 6px;
}
.status-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--text-success);
}
.status-dot.off {
  background: var(--text-error);
}
</style>
