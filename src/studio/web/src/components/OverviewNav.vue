<script setup lang="ts">
// 总览态左栏：数据页导航。对齐 mockup renderOvNav（.nav-group + .file + ico）。
// 概览组 o1-o5 + 分析组（体检/节奏/账本/篇详情/设定/配置）。
import { computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'

const props = defineProps<{ bookName?: string }>()
const route = useRoute()
const router = useRouter()

const enc = computed(() => (props.bookName ? encodeURIComponent(props.bookName) : ''))

interface NavItem { label: string; ico: string; to: string; match: (p: string) => boolean }
const groups = computed<{ title: string; items: NavItem[] }[]>(() => [
  {
    title: '概览',
    items: [
      { label: '作品概要', ico: '◉', to: `/books/${enc.value}`, match: (p) => p === `/books/${enc.value}` },
      { label: '字数统计', ico: '☰', to: `/books/${enc.value}/o2`, match: (p) => p.endsWith('/o2') },
      { label: '完成度', ico: '◯', to: `/books/${enc.value}/o3`, match: (p) => p.endsWith('/o3') },
      { label: '写作日历', ico: '▦', to: `/books/${enc.value}/o4`, match: (p) => p.endsWith('/o4') },
      { label: '近期动态', ico: '∿', to: `/books/${enc.value}/o5`, match: (p) => p.endsWith('/o5') },
    ],
  },
  {
    title: '分析',
    items: [
      { label: '体检', ico: '✚', to: `/books/${enc.value}/health`, match: (p) => p.endsWith('/health') },
      { label: '节奏', ico: '♪', to: `/books/${enc.value}/rhythm`, match: (p) => p.endsWith('/rhythm') },
      { label: '账本', ico: '§', to: `/books/${enc.value}/leads`, match: (p) => p.endsWith('/leads') },
      { label: '篇详情', ico: '❡', to: `/books/${enc.value}/piece/1`, match: (p) => p.includes('/piece/') },
      { label: '设定', ico: '⬡', to: `/books/${enc.value}/settings`, match: (p) => p.endsWith('/settings') },
      { label: '配置', ico: '⋎', to: `/books/${enc.value}/config`, match: (p) => p.endsWith('/config') },
    ],
  },
])

function go(to: string): void {
  router.push(to)
}
</script>

<template>
  <div v-for="g in groups" :key="g.title" class="tree-section">
    <div class="nav-group">{{ g.title }}</div>
    <div
      v-for="it in g.items"
      :key="it.to"
      class="file"
      :class="{ active: it.match(route.path) }"
      @click="go(it.to)"
    ><span class="nav-ico">{{ it.ico }}</span>{{ it.label }}</div>
  </div>
</template>

<style scoped>
/* mockup 未定义 .tree-section（语义容器）与 .nav-ico（图标列宽），此处补全；其余走 v5-components。 */
.tree-section{margin-bottom:4px}
.nav-ico{width:16px;text-align:center;color:var(--text-3);flex-shrink:0}
</style>