<script setup lang="ts">
// 总览态左栏：数据页导航（取代 BookTabs 的数据页部分；编辑/工作台在顶栏 mode-tab）
import { computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'

const props = defineProps<{ bookName?: string }>()
const route = useRoute()
const router = useRouter()

const enc = computed(() => (props.bookName ? encodeURIComponent(props.bookName) : ''))

interface NavItem {
  id: string
  label: string
  to: string
  match: (p: string) => boolean
}
const groups = computed<{ title: string; items: NavItem[] }[]>(() => [
  {
    title: '概览',
    items: [
      {
        id: 'overview',
        label: '作品概要',
        to: `/books/${enc.value}`,
        match: (p) => p === `/books/${enc.value}` || p.endsWith('/overview'),
      },
    ],
  },
  {
    title: '分析',
    items: [
      { id: 'health', label: '体检', to: `/books/${enc.value}/health`, match: (p) => p.endsWith('/health') },
      { id: 'rhythm', label: '节奏', to: `/books/${enc.value}/rhythm`, match: (p) => p.endsWith('/rhythm') },
      { id: 'leads', label: '账本', to: `/books/${enc.value}/leads`, match: (p) => p.endsWith('/leads') },
      {
        id: 'piece',
        label: '篇详情',
        to: `/books/${enc.value}/piece/1`,
        match: (p) => p.includes('/piece/'),
      },
      {
        id: 'settings',
        label: '设定',
        to: `/books/${enc.value}/settings`,
        match: (p) => p.endsWith('/settings'),
      },
      {
        id: 'config',
        label: '配置',
        to: `/books/${enc.value}/config`,
        match: (p) => p.endsWith('/config'),
      },
    ],
  },
])

function go(to: string): void {
  router.push(to)
}
</script>

<template>
  <div class="ov-nav">
    <div v-for="g in groups" :key="g.title" class="ov-group">
      <div class="ov-group-title">{{ g.title }}</div>
      <div
        v-for="it in g.items"
        :key="it.id"
        class="ov-item"
        :class="{ active: it.match(route.path) }"
        @click="go(it.to)"
      >{{ it.label }}</div>
    </div>
  </div>
</template>

<style scoped>
.ov-nav {
  padding: 4px 0;
}
.ov-group {
  margin-bottom: 12px;
}
.ov-group-title {
  color: var(--text-3);
  font-size: 10px;
  letter-spacing: 1px;
  padding: 8px 8px 4px;
  text-transform: uppercase;
}
.ov-item {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 6px 10px;
  margin: 1px 4px;
  color: var(--text-2);
  cursor: pointer;
  border-radius: 5px;
  font-size: 13px;
  user-select: none;
}
.ov-item:hover {
  background: var(--hover);
  color: var(--ink);
}
.ov-item.active {
  color: var(--ink-cyan);
  background: var(--active-bg);
  font-weight: 500;
}
</style>
