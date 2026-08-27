<script setup lang="ts">
// 状态栏：左连接态（useHeartbeat serverOnline + workbench.connected 合成三态）；
// 右 主题名。
import { computed } from 'vue'
import { useTheme } from '../../composables/useTheme'
import { serverOnline } from '../../composables/useHeartbeat'
import { useWorkbenchStore } from '../../stores/workbench'
import { useTreeStore } from '../../stores/tree'
import { useWordsStore } from '../../stores/words'
defineProps<{ bookName: string }>()
const { themeName } = useTheme()
const tree = useTreeStore()
const words = useWordsStore()
// R65-55（E-7）：并入 SSE 通道态——HTTP 心跳活着但 SSE 断连（fail-closed 退避/429/换书
// 断档）时，AI 进度事件实际全丢，此前仍绿灯「就绪」误导作者。三态：红=服务不可达，
// 黄=SSE 断（重连中），绿=全通
const wb = useWorkbenchStore()
type ConnState = 'off' | 'degraded' | 'on'
const connState = computed<ConnState>(() => {
  if (!serverOnline.value) return 'off'
  return wb.connected ? 'on' : 'degraded'
})
const connText = computed(() => {
  if (connState.value === 'off') return '无法连接到写作助手'
  if (connState.value === 'degraded') return '实时通道中断，重连中…'
  return '写作助手就绪'
})
</script>

<template>
  <div class="statusbar">
    <div class="status-left">
      <span class="status-dot" :class="connState" />
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
/* R65-55：SSE 断（服务心跳仍在）黄灯降级态 */
.status-dot.degraded {
  background: var(--dv-warn);
}
.status-words {
  font-variant-numeric: tabular-nums;
}
.sep {
  margin: 0 6px;
  color: var(--text-faint);
}
</style>
