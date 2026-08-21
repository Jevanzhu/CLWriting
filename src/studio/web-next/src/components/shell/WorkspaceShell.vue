<script setup lang="ts">
import { computed, ref, onUnmounted } from 'vue'
import Ribbon from './Ribbon.vue'
import SidebarLeft from './SidebarLeft.vue'
import SidebarRight from './SidebarRight.vue'
import TabBar from './TabBar.vue'
import ViewHeader from './ViewHeader.vue'
import StatusBar from './StatusBar.vue'
import ChatDock from './ChatDock.vue'
import ConfirmPrompt from '../ui/ConfirmPrompt.vue'
import CommandPalette from '../ui/CommandPalette.vue'
import SettingsModal from '../ui/SettingsModal.vue'
import ShelfModal from '../ui/ShelfModal.vue'
import ExportDialog from '../ui/ExportDialog.vue'
import Toast from '../ui/Toast.vue'
import TooltipHost from '../ui/TooltipHost.vue'
import { useHotkeys } from '../../composables/useHotkeys'
import { useWorkspaceStore } from '../../stores/workspace'
import { usePrefsStore } from '../../stores/prefs'
import { useTreeStore } from '../../stores/tree'

// Obsidian 工作区外壳：ribbon + 左侧栏 + 中央(tabbar+viewheader+视图) + 右侧栏 + 状态栏。
// flex 布局（非旧 web 的 overlay 浮层）；折叠走 width 过渡，专注模式覆盖折叠态。
// macOS 交通灯处理在 Ribbon 列内（顶部留白 + 可拖动），主区/sidebar 顶部与交通灯同排。
defineProps<{ bookName: string }>()

const ws = useWorkspaceStore()
const prefs = usePrefsStore()
const tree = useTreeStore()
useHotkeys()

// 专注模式覆盖：focus 时左右栏视觉收起，退出恢复 leftOpen/rightOpen 原值
const leftVisible = computed(() => ws.leftOpen && !ws.focusMode)
const rightVisible = computed(() => ws.rightOpen && !ws.focusMode)

/** dock B 当前章号：从活动文档树节点 path 的文件名首部数字推断（如 0001.md → 1） */
const dockChapter = computed(() => {
  const docId = ws.activeDocId
  if (!docId) return undefined
  const node = tree.byDocId.get(docId)
  if (!node) return undefined
  const basename = node.path.split('/').pop() ?? ''
  const m = basename.match(/^(\d+)/)
  return m ? Number(m[1]) : undefined
})

/** 拖拽调整左栏宽度（最小 180px 由 store setLeftWidth 兜底） */
const leftDragging = ref(false)
/** 右边缘 4px 热区：mousemove 切换 col-resize 光标，mousedown 启动拖拽 */
function onLeftMouseMove(e: MouseEvent): void {
  if (!leftVisible.value) return
  const el = e.currentTarget as HTMLElement
  el.style.cursor = e.clientX >= el.getBoundingClientRect().right - 4 ? 'col-resize' : ''
}
function onLeftMouseDown(e: MouseEvent): void {
  if (!leftVisible.value) return
  const el = e.currentTarget as HTMLElement
  if (e.clientX >= el.getBoundingClientRect().right - 4) {
    startResizeLeft(e)
  }
}
let resizeCleanup: (() => void) | null = null
function startResizeLeft(e: MouseEvent): void {
  e.preventDefault()
  const startX = e.clientX
  const startWidth = ws.leftWidth
  leftDragging.value = true
  function onMove(ev: MouseEvent): void {
    ws.setLeftWidth(startWidth + ev.clientX - startX)
  }
  function onUp(): void {
    document.removeEventListener('mousemove', onMove)
    document.removeEventListener('mouseup', onUp)
    document.body.style.cursor = ''
    document.body.style.userSelect = ''
    leftDragging.value = false
    resizeCleanup = null
  }
  document.addEventListener('mousemove', onMove)
  document.addEventListener('mouseup', onUp)
  document.body.style.cursor = 'col-resize'
  document.body.style.userSelect = 'none'
  resizeCleanup = onUp
}
// 兜底：拖拽中卸载时清理残留 document 监听（正常由 onUp 在 mouseup 清理）
onUnmounted(() => resizeCleanup?.())
</script>

<template>
  <div class="ws-shell">
    <div class="ws-body">
      <Ribbon />
      <div
        class="ws-side ws-left"
        :class="{ collapsed: !leftVisible, dragging: leftDragging }"
        :style="{ '--left-width': ws.leftWidth + 'px' }"
        @mousedown="onLeftMouseDown"
        @mousemove="onLeftMouseMove"
      >
        <SidebarLeft :book-name="bookName" />
      </div>
      <main class="ws-main">
        <TabBar :book-name="bookName" />
        <ViewHeader v-if="ws.activeView !== 'editor'" :book-name="bookName" />
        <div class="ws-view">
          <slot />
        </div>
        <!-- 对话助手 dock B（开关默认关闭，开启时底部可折叠面板；工作台视图有对话 tab，不叠 dock） -->
        <ChatDock
          v-if="prefs.chatEnabled && !ws.focusMode && ws.activeView !== 'workbench'"
          :book-name="bookName"
          :current-chapter="dockChapter"
        />
      </main>
      <div class="ws-side ws-right" :class="{ collapsed: !rightVisible }">
        <SidebarRight :book-name="bookName" />
      </div>
    </div>
    <StatusBar :book-name="bookName" />
    <ConfirmPrompt />
    <CommandPalette />
    <SettingsModal />
    <ShelfModal />
    <ExportDialog />
    <Toast />
    <TooltipHost />
  </div>
</template>

<style scoped>
.ws-shell {
  display: flex;
  flex-direction: column;
  height: 100vh;
  overflow: hidden;
}
.ws-body {
  display: flex;
  flex: 1;
  min-height: 0;
  position: relative; /* 展开右栏按钮（.ws-reopen-right）的定位基准 */
}
.ws-side {
  flex-shrink: 0;
  overflow: hidden;
  transition: width var(--dur-norm) var(--ease-out);
}
.ws-side.dragging {
  transition: none;  /* 拖拽时即时响应，不做宽度过渡 */
}
.ws-left {
  width: var(--left-width, 240px);
  border-right: 1px solid var(--background-modifier-border);
  background: var(--background-secondary);
}
.ws-right {
  width: 260px;
  border-left: 1px solid var(--background-modifier-border);
  background: var(--background-secondary);
}
.ws-left.collapsed,
.ws-right.collapsed {
  width: 0;
  border: 0;
}
.ws-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  background: var(--background-primary);
  position: relative; /* ChatDock 漂浮 FAB 的定位基准 */
}
.ws-view {
  flex: 1;
  overflow: auto;
}
</style>
