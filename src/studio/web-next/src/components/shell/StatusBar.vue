<script setup lang="ts">
// 状态栏：左连接态（useHeartbeat serverOnline）；右 主题名。
import { computed } from 'vue'
import { useTheme } from '../../composables/useTheme'
import { serverOnline } from '../../composables/useHeartbeat'
import { useTreeStore } from '../../stores/tree'
import { useWordsStore } from '../../stores/words'
defineProps<{ bookName: string }>()
const { themeName } = useTheme()
const tree = useTreeStore()
const words = useWordsStore()
const connText = computed(() => {
  if (!serverOnline.value) return '无法连接到写作助手'
  return '写作助手就绪'
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
