<script setup lang="ts">
// 错误态卡片（对齐 mockup .state-error，v5-components.css:538）。
// 各数据页加载失败时统一展示：图标 + 标题 + 描述 + 重试按钮，替代简陋的单行红字。
withDefaults(
  defineProps<{ msg: string; title?: string; icon?: string; retry?: boolean }>(),
  { title: '加载失败', icon: '⚠', retry: true },
)
defineEmits<{ retry: [] }>()
</script>

<template>
  <div class="state-error">
    <div class="err-icon">{{ icon }}</div>
    <div class="err-title">{{ title }}</div>
    <div class="err-desc">{{ msg }}</div>
    <span v-if="retry" class="btn primary" @click="$emit('retry')">↻ 重试</span>
  </div>
</template>
