<script setup lang="ts">
import { computed, onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import AppShell from './layouts/AppShell.vue'
import TitleBar from './components/TitleBar.vue'

const router = useRouter()
const route = useRoute()

// 启动初始态：--book 指定的书 → 直进单书（仅当当前停在书架首页时）
onMounted(async () => {
  try {
    const r = await fetch('/api/boot')
    if (!r.ok) return
    const data = (await r.json()) as { initialBook?: string }
    if (data.initialBook && router.currentRoute.value.path === '/') {
      router.push(`/books/${encodeURIComponent(data.initialBook)}`)
    }
  } catch {
    // boot 失败不影响书架浏览
  }
})

// 单书页面套 AppShell；书架(/)、建书(/books/new) 保持全屏
const inBook = computed(
  () => route.path.startsWith('/books/') && route.path !== '/books/new' && !!route.params.name,
)

type Mode = 'overview' | 'edit' | 'workbench'
// mode 由路由推断（第一刀：mode-tab 视觉高亮 + 跳路由驱动）
const mode = computed<Mode>(() => {
  if (route.path.endsWith('/edit')) return 'edit'
  if (route.path.endsWith('/workbench')) return 'workbench'
  return 'overview'
})
const bookName = computed(() => (route.params.name as string) || '')
</script>

<template>
  <TitleBar />
  <AppShell v-if="inBook" :mode="mode" :book-name="bookName">
    <router-view />
  </AppShell>
  <div v-else class="full-host">
    <router-view />
  </div>
</template>

<style scoped>
/* 全局样式交给 styles/tokens.css；App.vue 仅保留挂载结构。
   入口页容器：TitleBar 占顶 38px，剩余空间撑满给 .workspace.full 滚动。 */
.full-host {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
.full-host :deep(.workspace.full) {
  flex: 1;
  min-height: 0;
}
</style>
