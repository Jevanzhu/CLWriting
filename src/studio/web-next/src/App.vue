<script setup lang="ts">
import { onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { getLastInitialBook } from './api/client'
import { useAppActions } from './composables/useAppActions'
import ErrorBoundary from './components/ui/ErrorBoundary.vue'

// 根组件：路由出口 + 启动 initialBook 直进工作区（/api/boot 返回时）。
const router = useRouter()
const { dispatch: dispatchAction } = useAppActions()
onMounted(() => {
  // 书架独立窗口（win=shelf）：不 redirect，保持书架页
  const isShelfWin = new URLSearchParams(location.search).get('win') === 'shelf'
  // 主窗口接收书架窗口的导航（选书 → 主进程转发 → router.push）
  window.clwritingDesktop?.onNavigate((path) => {
    router.push(path)
  })
  // 系统菜单 click → 主进程转发 actionKey → dispatch 到 store 动作（与命令面板同源）
  window.clwritingDesktop?.onMenuAction((key) => dispatchAction(key))
  if (isShelfWin) return
  // 主窗口启动：initialBook（--book）> lastBook（localStorage）> 默认 /shelf
  let startBook: string | null = getLastInitialBook()
  if (!startBook) {
    try {
      startBook = localStorage.getItem('clw-last-book')
    } catch {
      /* 忽略 */
    }
  }
  if (startBook && location.pathname === '/') {
    router.replace(`/book/${encodeURIComponent(startBook)}`)
  }
})
</script>

<template>
  <ErrorBoundary>
    <router-view />
  </ErrorBoundary>
</template>
