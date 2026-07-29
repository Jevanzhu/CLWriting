<script setup lang="ts">
// 可折叠分区：标题条点击 toggle，v-show 展开内容参与外层滚动（非内部固定高滚动）。
import { ref } from 'vue'
import { ChevronDown } from 'lucide-vue-next'

const props = withDefaults(defineProps<{ title: string; defaultOpen?: boolean }>(), {
  defaultOpen: true,
})
const open = ref(props.defaultOpen)
</script>

<template>
  <div class="collapse-section">
    <button class="collapse-head" @click="open = !open">
      <ChevronDown :size="14" class="collapse-arrow" :class="{ rotated: !open }" />
      <span class="collapse-title">{{ title }}</span>
    </button>
    <div v-show="open" class="collapse-body">
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
