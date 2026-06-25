<script setup lang="ts">
import { computed, onMounted, onUnmounted } from 'vue'

const props = defineProps<{
  name: string
  active: 'overview' | 'health' | 'rhythm' | 'leads' | 'settings' | 'workbench' | 'edit' | 'config' | 'piece'
}>()
const enc = computed(() => encodeURIComponent(props.name))

// #1.5 单写者协作：进书心跳写 .gui-active（每 20s 续期），CLI 写命令据此轻提示
let timer: ReturnType<typeof setInterval> | null = null
async function heartbeat(): Promise<void> {
  try {
    await fetch(`/api/books/${enc.value}/heartbeat`, { method: 'POST' })
  } catch {
    // 心跳失败忽略（尽力而为，不阻塞 UI）
  }
}
onMounted(() => {
  heartbeat()
  timer = setInterval(heartbeat, 20_000)
})
onUnmounted(() => {
  if (timer) clearInterval(timer)
})
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
    <RouterLink :to="`/books/${enc}/config`" :class="{ active: active === 'config' }">配置</RouterLink>
  </nav>
</template>

<style scoped>
.book-tabs {
  display: flex;
  gap: 4px;
  border-bottom: 1px solid var(--border);
  margin-bottom: 20px;
}
.book-tabs a {
  padding: 8px 16px;
  color: var(--text-2);
  text-decoration: none;
  font-size: 14px;
  border-bottom: 2px solid transparent;
  margin-bottom: -1px;
}
.book-tabs a:hover {
  color: var(--ink-cyan);
}
.book-tabs a.active {
  color: var(--ink-cyan);
  border-bottom-color: var(--ink-cyan);
  font-weight: 600;
}
.book-tabs .placeholder {
  padding: 8px 16px;
  color: var(--border);
  font-size: 14px;
  cursor: not-allowed;
}
</style>
