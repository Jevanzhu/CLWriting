<script setup lang="ts">
import { computed } from 'vue'

const props = defineProps<{
  name: string
  active: 'overview' | 'health' | 'rhythm' | 'leads' | 'settings' | 'workbench' | 'edit'
}>()
const enc = computed(() => encodeURIComponent(props.name))
</script>

<template>
  <nav class="book-tabs">
    <RouterLink :to="`/books/${enc}`" :class="{ active: active === 'overview' }">总览</RouterLink>
    <RouterLink :to="`/books/${enc}/health`" :class="{ active: active === 'health' }">体检</RouterLink>
    <RouterLink :to="`/books/${enc}/rhythm`" :class="{ active: active === 'rhythm' }">节奏</RouterLink>
    <RouterLink :to="`/books/${enc}/leads`" :class="{ active: active === 'leads' }">账本</RouterLink>
    <RouterLink :to="`/books/${enc}/settings`" :class="{ active: active === 'settings' }">设定</RouterLink>
    <RouterLink :to="`/books/${enc}/workbench`" :class="{ active: active === 'workbench' }">工作台</RouterLink>
    <RouterLink :to="`/books/${enc}/edit`" :class="{ active: active === 'edit' }">编辑</RouterLink>
  </nav>
</template>

<style scoped>
.book-tabs {
  display: flex;
  gap: 4px;
  border-bottom: 1px solid #e5e7eb;
  margin-bottom: 20px;
}
.book-tabs a {
  padding: 8px 16px;
  color: #6b7280;
  text-decoration: none;
  font-size: 14px;
  border-bottom: 2px solid transparent;
  margin-bottom: -1px;
}
.book-tabs a:hover {
  color: #3b82f6;
}
.book-tabs a.active {
  color: #3b82f6;
  border-bottom-color: #3b82f6;
  font-weight: 600;
}
.book-tabs .placeholder {
  padding: 8px 16px;
  color: #d1d5db;
  font-size: 14px;
  cursor: not-allowed;
}
</style>
