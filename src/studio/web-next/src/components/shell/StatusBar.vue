<script setup lang="ts">
// 状态栏：左 CLI 连接态（useHeartbeat serverOnline）；右 主题名。T0.4 接心跳；字数/保存态随 P2 加。
import { computed } from 'vue'
import { useTheme } from '../../composables/useTheme'
import { serverOnline } from '../../composables/useHeartbeat'
import { useTreeStore } from '../../stores/tree'
import { useWordsStore } from '../../stores/words'
import { useUiStore } from '../../stores/ui'
defineProps<{ bookName: string }>()
const { themeName } = useTheme()
const tree = useTreeStore()
const words = useWordsStore()
const ui = useUiStore()
// aiDriver = 当前供应商名（ai-status 返回）；空 = 未配置
const connText = computed(() => {
  if (!serverOnline.value) return '服务连接中断'
  return ui.aiAvailable && ui.aiDriver ? `${ui.aiDriver} 已连接` : '服务已连接'
})
</script>

<template>
  <div class="statusbar">
    <div class="status-left">
      <span class="status-dot" :class="{ off: !serverOnline }" />
      <span>{{ connText }}</span>
    </div>
    <div class="status-right">
      <span v-if="tree.totalWords" class="status-words">
        全书 {{ tree.totalWords.toLocaleString() }}<span class="sep">·</span>今日 +{{ words.todayWords.toLocaleString() }}
      </span>
      <span v-if="tree.totalWords" class="sep">·</span>
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
  font-size: var(--font-size-xs);
  color: var(--text-muted);
}
.status-left {
  display: flex;
  align-items: center;
  gap: 6px;
}
.status-right {
  display: flex;
  align-items: center;
  gap: 6px;
}
.status-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--dv-good);
}
.status-dot.off {
  background: var(--text-error);
}
.status-words {
  font-variant-numeric: tabular-nums;
}
.sep {
  margin: 0 6px;
  color: var(--text-faint);
}
</style>
