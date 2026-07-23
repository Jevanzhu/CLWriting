<script setup lang="ts">
// T0.1 临时占位页，验证脚手架可跑；T0.5 被 Shelf.vue / Book.vue 取代后删除。
// T0.2 临时挂主题切换按钮（验证 light/dark），T0.3 ribbon 接管后移除。
import { useTheme } from '../composables/useTheme'
defineProps<{ title: string }>()
const { theme, themeName, toggle } = useTheme()
</script>

<template>
  <main class="placeholder">
    <h1>{{ title }}</h1>
    <p class="progress">
      P0 进度：T0.1 脚手架 ✓ / T0.2 tokens ✓ / T0.3 外壳 待做 / T0.4 api 待做 / T0.5 视图 待做。
    </p>
    <button class="theme-toggle" @click="toggle">
      主题：{{ themeName() }}（{{ theme }}）—— 点击切换
    </button>
  </main>
</template>

<style scoped>
.placeholder {
  font-family: var(--font-ui);
  padding: 2rem;
  color: var(--text-muted);
}
.progress {
  margin: 0.5rem 0;
}
.theme-toggle {
  margin-top: 1rem;
  padding: 6px 14px;
  border: 1px solid var(--background-modifier-border);
  border-radius: var(--radius-s);
  background: var(--interactive-normal);
  color: var(--text-normal);
  font-size: 13px;
  cursor: pointer;
}
.theme-toggle:hover {
  background: var(--interactive-hover);
}
</style>
