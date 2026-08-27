<script setup lang="ts">
import { computed, ref, onUnmounted } from 'vue'
import Ribbon from './Ribbon.vue'
import SidebarLeft from './SidebarLeft.vue'
import SidebarRight from './SidebarRight.vue'
import TabBar from './TabBar.vue'
import ViewHeader from './ViewHeader.vue'
import StatusBar from './StatusBar.vue'
import ChatDock from './ChatDock.vue'
import FocusFormatBar from './FocusFormatBar.vue'
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
import { onFullScreenChange } from '../../shared/fullscreen'

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
// 全屏反向同步：作者经系统手势（⌘⌃F/绿按钮）退出全屏 → 连带退出专注（专注隐了
// Ribbon/TabBar，全屏也被系统退了却留在专注态会显得「卡住」）。进入全屏不反向
// 开启专注——系统菜单「切换全屏」是独立功能，全屏 ≠ 专注。
const stopFsWatch = onFullScreenChange((fs) => {
  if (!fs && ws.focusMode) ws.setFocus(false)
})

// 兜底：拖拽中卸载时清理残留 document 监听（正常由 onUp 在 mouseup 清理）
onUnmounted(() => {
  resizeCleanup?.()
  stopFsWatch()
})
</script>

<template>
  <div class="ws-shell" :class="{ 'ws-focus': ws.focusMode }">
    <div class="ws-body">
      <Ribbon v-show="!ws.focusMode" />
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
        <!-- 专注模式：TabBar 隐藏后顶部拖拽区丢失，补一条透明拖拽条（macOS 窗口移动） -->
        <div v-if="ws.focusMode" class="ws-focus-drag" aria-hidden="true" />
        <TabBar v-show="!ws.focusMode" :book-name="bookName" />
        <ViewHeader v-if="ws.activeView !== 'editor' && !ws.focusMode" :book-name="bookName" />
        <div class="ws-view">
          <slot />
        </div>
        <!-- 专注退出按钮：沉浸态常驻右下角（半透明，hover 加深），防找不到出口 -->
        <button
          v-if="ws.focusMode"
          class="ws-focus-exit"
          type="button"
          title="退出专注模式（Esc / ⌘⇧F）"
          @click="ws.toggleFocus()"
        >
          退出专注
        </button>
        <!-- 专注排版浮动条：贴纸张右缘竖状常驻（半透明，hover 加深；窄窗回落窗口右缘，
             定位见 FocusFormatBar 样式注释），字号/行距/纸宽/字体所见即所得；
             仅编辑器视图渲染（排版只对编辑区有意义，ChatDock 同款条件式先例） -->
        <FocusFormatBar v-if="ws.focusMode && ws.activeView === 'editor'" />
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
    <StatusBar v-show="!ws.focusMode" :book-name="bookName" />
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
/* ===== 专注模式（完全沉浸） ===== */
/* 顶部拖拽条：TabBar/Ribbon 隐藏后唯一窗口拖拽区（透明，不拦截内容点击） */
.ws-focus-drag {
  flex-shrink: 0;
  height: 28px;
  -webkit-app-region: drag;
}
/* 退出按钮：右下角半透明常驻，hover 加深 */
.ws-focus-exit {
  position: absolute;
  right: var(--size-4-4, 16px);
  bottom: var(--size-4-4, 16px);
  z-index: 5;
  padding: 4px 12px;
  border: 1px solid var(--background-modifier-border);
  border-radius: var(--radius-s, 4px);
  background: var(--background-secondary);
  color: var(--text-muted);
  font-size: var(--font-size-sm, 12px);
  cursor: pointer;
  opacity: 0.35;
  transition: opacity var(--dur-norm) var(--ease-out);
}
.ws-focus-exit:hover {
  opacity: 1;
}

</style>
