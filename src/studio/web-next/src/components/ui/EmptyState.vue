<script setup lang="ts">
// 统一空态组件（P2-4）：图标 + 标题 + 文案 + 可选行动区（默认 slot）。
// 三档密度：
//   full    — 门面/全屏（书库空、编辑器空）：图标 48 + 标题 + 副标题 + 按钮
//   block   — 区域级（learn 收割空态）：图标 40 + 文案
//   compact — 卡片内（分析卡/热力/事件流）：图标 14 + 单行文案，水平排
// 外层布局（max-width / height / margin）不接管，由调用方 class 覆盖。
import { computed, type Component } from 'vue'

const props = withDefaults(
  defineProps<{
    icon?: Component
    title?: string
    text?: string
    size?: 'full' | 'block' | 'compact'
  }>(),
  { size: 'block' },
)

const iconSize = computed(() =>
  props.size === 'full' ? 48 : props.size === 'compact' ? 14 : 40,
)
</script>

<template>
  <div class="empty-state" :class="`es-${size}`">
    <component :is="icon" v-if="icon" :size="iconSize" class="es-icon" />
    <p v-if="title" class="es-title">{{ title }}</p>
    <p v-if="text" class="es-text">{{ text }}</p>
    <slot />
  </div>
</template>

<style scoped>
.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--size-4-2);
  color: var(--text-faint);
}
.es-icon {
  color: var(--text-faint);
  flex-shrink: 0;
}
.es-title {
  margin: 0;
  font-weight: 600;
  color: var(--text-muted);
  font-family: var(--font-ui);
}
.es-text {
  margin: 0;
  line-height: 1.6;
}

/* full：门面/全屏 */
.es-full {
  padding: var(--size-4-8) var(--size-4-4);
  gap: var(--size-4-2);
}
.es-full .es-title {
  font-size: 16px;
}
.es-full .es-text {
  font-size: 13px;
}

/* block：区域级 */
.es-block {
  padding: var(--size-4-6);
  gap: var(--size-4-3);
}
.es-block .es-text {
  font-size: 13px;
}

/* compact：卡片内（图标 + 单行文案水平排） */
.es-compact {
  flex-direction: row;
  gap: 6px;
  padding: 2px 0;
}
.es-compact .es-text {
  font-size: 12px;
}
</style>
