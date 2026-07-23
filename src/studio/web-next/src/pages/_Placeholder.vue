<script setup lang="ts">
// T0.1 临时占位页，验证脚手架可跑；T0.5 被 Shelf.vue / Book.vue 取代后删除。
defineProps<{ title: string }>()
</script>

<template>
  <main class="placeholder">
    <h1>{{ title }}</h1>
    <p>web-next 脚手架（P0 T0.1）已就绪 —— 待 T0.2 tokens / T0.3 外壳 / T0.5 视图实现。</p>
  </main>
</template>

<style scoped>
.placeholder {
  font-family: system-ui, -apple-system, 'PingFang SC', sans-serif;
  padding: 2rem;
  color: #666;
}
</style>
