<script setup lang="ts">
import { onMounted, onBeforeUnmount } from 'vue'
import { useRouter } from 'vue-router'
import { getLastInitialBook } from './api/client'
import { useAppActions } from './composables/useAppActions'
import ErrorBoundary from './components/ui/ErrorBoundary.vue'
import StartupNoticeBanner from './components/ui/StartupNoticeBanner.vue'
// R42-3/R42-4（四十二轮）：反馈层与三模态上移根组件全局挂载——此前仅挂 WorkspaceShell，
// /welcome、/library、书库独立窗口上 ui.toast 静默失效（switchLibrary 取消原因/
// openLibraryDir 失败无渲染点）、系统菜单「设置/新建书/导出」（CmdOrCtrl+, / Cmd+N /
// Cmd+E 经 useAppActions 只置 store 标志位）在非工作区路由整面静默空操作。五件均
// Teleport to body / fixed 定位、store 驱动无 props，全局挂载零布局影响。
import Toast from './components/ui/Toast.vue'
import ConfirmPrompt from './components/ui/ConfirmPrompt.vue'
import SettingsModal from './components/ui/SettingsModal.vue'
import ShelfModal from './components/ui/ShelfModal.vue'
import ExportDialog from './components/ui/ExportDialog.vue'

// 根组件：路由出口 + 启动 initialBook 直进工作区（/api/boot 返回时）。
const router = useRouter()
const { dispatch: dispatchAction } = useAppActions()
onMounted(() => {
  // 书架独立窗口（win=shelf）：不 redirect，保持书架页
  const isShelfWin = new URLSearchParams(location.search).get('win') === 'shelf'
  // 主窗口接收书架窗口的导航（选书 → 主进程转发 → router.push）
  // R33-88（三十三轮）：监听句柄成对清理（根组件常驻无实害，防御性收口对齐全库口径）
  const offNavigate = window.clwritingDesktop?.onNavigate((path) => {
    router.push(path)
  })
  // 系统菜单 click → 主进程转发 actionKey → dispatch 到 store 动作（与命令面板同源）
  const offMenuAction = window.clwritingDesktop?.onMenuAction((key) => dispatchAction(key))
  onBeforeUnmount(() => {
    offNavigate?.()
    offMenuAction?.()
  })
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
  // R50-D1-2（五十轮）：lastBook 恢复直进改以路由态为判据——裸 location.pathname 在
  // onMounted 时刻与路由初始导航（'/' redirect '/shelf'）有竞态（初始导航完成前后读值
  // 不一）；isReady 后读 currentRoute.path 才是权威路径。保留原语义：仅根路径时恢复直进
  if (startBook) {
    const book = startBook
    void router.isReady().then(() => {
      if (router.currentRoute.value.path === '/') {
        router.replace(`/book/${encodeURIComponent(book)}`)
      }
    })
  }
})
</script>

<template>
  <ErrorBoundary>
    <StartupNoticeBanner />
    <router-view />
    <!-- R42-3/R42-4：全局反馈层与模态（Teleport 到 body；离开工作区路由也活着） -->
    <Toast />
    <ConfirmPrompt />
    <SettingsModal />
    <ShelfModal />
    <ExportDialog />
  </ErrorBoundary>
</template>
