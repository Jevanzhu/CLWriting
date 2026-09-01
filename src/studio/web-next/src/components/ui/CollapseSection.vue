<script setup lang="ts">
// 可折叠分区：标题条点击 toggle，v-show 展开内容参与外层滚动（非内部固定高滚动）。
// R34D-30（三十四轮）：可选受控模式（v-model:open）——折叠态原为组件内部 ref，
// 随外层 v-if 卸载重建即归位 defaultOpen（如 SidebarRight 切 tab/切文档），手动
// 折叠丢失；受控时状态由宿主持有、跨卸载存活。未传 open 的旧用法（WbAdvanced 等）
// 仍走内部态，行为不变。
import { computed, ref } from 'vue'
import { ChevronDown } from 'lucide-vue-next'
import BetaBadge from './BetaBadge.vue'

const props = withDefaults(
  defineProps<{ title: string; beta?: boolean; defaultOpen?: boolean; open?: boolean }>(),
  { defaultOpen: true, open: undefined },
)
const emit = defineEmits<{ 'update:open': [value: boolean] }>()
// 内部态：非受控时唯一事实源；受控时仅兜底（显示以 props.open 为准）
const innerOpen = ref(props.defaultOpen)
const isOpen = computed(() => (props.open === undefined ? innerOpen.value : props.open))
function onToggle(): void {
  const next = !isOpen.value
  innerOpen.value = next
  emit('update:open', next)
}
</script>

<template>
  <div class="collapse-section">
    <button class="collapse-head" @click="onToggle">
      <ChevronDown :size="14" class="collapse-arrow" :class="{ rotated: !isOpen }" />
      <span class="collapse-title">{{ title }}</span>
      <BetaBadge v-if="beta" />
    </button>
    <div v-show="isOpen" class="collapse-body">
      <slot />
    </div>
  </div>
</template>

<style scoped>
.collapse-section {
  display: flex;
  flex-direction: column;
}
.collapse-head {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 4px 0;
  border: none;
  background: transparent;
  cursor: pointer;
  font-size: var(--font-size-xs);
  font-weight: 600;
  color: var(--text-faint);
  text-transform: uppercase;
  letter-spacing: 0.05em;
}
.collapse-arrow {
  transition: transform var(--dur-fast) var(--ease-out);
  color: var(--text-faint);
  flex-shrink: 0;
}
.collapse-arrow.rotated {
  transform: rotate(-90deg);
}
.collapse-body {
  padding-top: var(--size-4-2);
}
</style>
