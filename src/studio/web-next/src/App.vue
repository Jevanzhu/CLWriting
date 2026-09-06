<script setup lang="ts">
import { onMounted, onBeforeUnmount } from 'vue'
import { useRouter } from 'vue-router'
import { getLastInitialBook } from './api/client'
import { useAppActions } from './composables/useAppActions'
import { usePrefsStore } from './stores/prefs'
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
const prefs = usePrefsStore()
// R58-A-1（五十八轮）：订阅句柄提升到 setup 顶层——onBeforeUnmount 此前注册在
// onMounted 回调体内（该时机无活动组件实例，钩子永不绑定，off 清理成死代码且每次
// 启动产「no active component instance」dev 告警）；句柄/清理同层注册，全库 on/off
// 配对口径收齐。
let offNavigate: (() => void) | undefined
let offMenuAction: (() => void) | undefined
type FlushPrefsWindow = Window & { __clwFlushPrefs?: () => void }
onMounted(() => {
  // 书架独立窗口（win=shelf）：不 redirect，保持书架页
  const isShelfWin = new URLSearchParams(location.search).get('win') === 'shelf'
  // 主窗口接收书架窗口的导航（选书 → 主进程转发 → router.push）
  // R33-88（三十三轮）：监听句柄成对清理（根组件常驻无实害，防御性收口对齐全库口径）
  offNavigate = window.clwritingDesktop?.onNavigate((path) => {
    router.push(path)
  })
  // 系统菜单 click → 主进程转发 actionKey → dispatch 到 store 动作（与命令面板同源）
  offMenuAction = window.clwritingDesktop?.onMenuAction((key) => dispatchAction(key))
  // R58-B-2（五十八轮）：关窗前全局偏好冲刷钩子——主进程 flushRendererBeforeClose 的
  // 同一 executeJavaScript 表达式内调用（Electron 卸载路径禁同步 XHR，不能靠 beforeunload）；
  // 500ms 防抖窗内的最后一次改动随关窗落盘，不再丢。任何窗口（含书库/书架独立窗）都可用。
  ;(window as FlushPrefsWindow).__clwFlushPrefs = () => prefs.flushPendingPersist()
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
onBeforeUnmount(() => {
  offNavigate?.()
  offMenuAction?.()
  delete (window as FlushPrefsWindow).__clwFlushPrefs
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
