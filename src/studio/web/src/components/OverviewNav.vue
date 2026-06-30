<script setup lang="ts">
// 总览态左栏：数据页导航。对齐 mockup renderOvNav（.nav-group + .file + ico）。
// 导航项对应真实路由：mockup OV_NAV 的 o2字数/o3完成度/o4日历/o5动态/a_relations 无对应路由 → 省略（不造假入口）。
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