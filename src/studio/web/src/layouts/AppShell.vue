<script setup lang="ts">
// AppShell（v5 照搬）：Electron 原生窗口提供交通灯/标题栏，Vue 仅 .app 应用内容。
// 结构/数值全走 v5-components.css（.app/.sider-slot/.sider-left/.topbar/.workspace/.content/.sider-right/.mode-tabs/.statusbar）。
// 三栏纯 overlay：左 sider-slot 浮左空白 / 中 content 居中(max-width) / 右 sider-right 浮右空白；窄窗容器查询折叠。
import { computed, ref, onMounted, onUnmounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { NTooltip } from 'naive-ui'
import { useTheme } from '../composables/useTheme'
import { useHeartbeat, serverOnline } from '../composables/useHeartbeat'
import { useHint } from '../composables/useHint'
import { useEditorState } from '../composables/useEditorState'
import OverviewNav from '../components/OverviewNav.vue'
import FileTree from '../components/FileTree.vue'
import TaskList from '../components/TaskList.vue'
import DataDetail from '../components/DataDetail.vue'
import ContextPanel from '../components/ContextPanel.vue'
import EventStream from '../components/EventStream.vue'
import BookAnchor from '../components/BookAnchor.vue'
import Binder from '../components/Binder.vue'
import SiderFoot from '../components/SiderFoot.vue'
import SettingsModal from '../components/SettingsModal.vue'
import CommandPalette from '../components/CommandPalette.vue'

type Mode = 'overview' | 'edit' | 'workbench'

const props = defineProps<{
  mode: Mode
  bookName?: string
}>()

const route = useRoute()
const router = useRouter()
const { themeName } = useTheme()
const { state: hintState, hint } = useHint()
const { triggerSave } = useEditorState()

const enc = computed(() => (props.bookName ? encodeURIComponent(props.bookName) : ''))

// 1.5 单写者协作心跳（常驻 shell）
useHeartbeat(() => enc.value)

const showSettings = ref(false)
const showPalette = ref(false)
const focus = ref(false)     // ⤢ 专注：折叠左右栏（仅编辑态）
const foldL = ref(false)     // ⌘B 折叠左栏（对齐 mockup state.foldL）
const panelOpen = ref(true)  // ◧ 详情面板：右栏开关
// 右栏跟随中栏滚动（对齐 mockup core.js:152-154 syncScroll）
const contentScroll = ref<HTMLElement>()
const siderRightInner = ref<HTMLElement>()
function syncScroll(): void {
  if (contentScroll.value && siderRightInner.value) {
    siderRightInner.value.scrollTop = contentScroll.value.scrollTop
  }
}

// ⌘P 命令面板 / ⌘S 保存（编辑态）/ ⌘B 折叠左栏 / ⌘⇧F 专注 / ⌘E⌘O⌘W 切模式
function onGlobalKey(e: KeyboardEvent): void {
  const cmd = e.metaKey || e.ctrlKey
  if (!cmd) return
  const k = e.key.toLowerCase()
  if (k === 'p') {
    e.preventDefault()
    showPalette.value = true
  } else if (k === 's' && props.mode === 'edit') {
    e.preventDefault()
    triggerSave()
  } else if (k === 'b') {
    e.preventDefault()
    foldL.value = !foldL.value
    hint(foldL.value ? '已折叠侧栏' : '已展开侧栏')
  } else if (k === 'f' && e.shiftKey) {
    e.preventDefault()
    toggleFocus()
  } else if (k === 'e' && props.bookName) {
    e.preventDefault()
    switchMode('edit')
  } else if (k === 'o' && props.bookName) {
    e.preventDefault()
    switchMode('overview')
  } else if (k === 'w' && props.bookName) {
    e.preventDefault()
    switchMode('workbench')
  }
}
onMounted(() => window.addEventListener('keydown', onGlobalKey))
onUnmounted(() => window.removeEventListener('keydown', onGlobalKey))

const modes: { id: Mode; label: string }[] = [
  { id: 'overview', label: '总览' },
  { id: 'edit', label: '编辑' },
  { id: 'workbench', label: '工作台' },
]

function switchMode(m: Mode): void {
  if (!props.bookName) return
  const base = `/books/${enc.value}`
  const path = m === 'overview' ? base : m === 'edit' ? `${base}/edit` : `${base}/workbench`
  router.push(path)
}

/** ←书架：返回书架页（路由 /shelf） */
function goShelf(): void {
  router.push('/shelf')
}

/** ⤢ 专注模式：折叠左右栏（仅编辑态）；对齐 mockup showHint 反馈 */
function toggleFocus(): void {
  focus.value = !focus.value
  if (!focus.value) {
    hint('已退出专注')
  } else if (props.mode === 'edit') {
    hint('专注模式 · 编辑框独占（再按 ⤢ 或 ⌘⇧F 退出）')
  } else {
    focus.value = false
    hint('专注模式仅编辑态可用')
  }
}

/** ◧ 详情面板：右栏开关；对齐 mockup showHint 反馈 */
function togglePanel(): void {
  panelOpen.value = !panelOpen.value
  hint(panelOpen.value ? '已展开详情面板' : '已收起详情面板')
}
const modeLabel = computed(
  () => ({ overview: '总览', edit: '编辑', workbench: '工作台' }[props.mode]),
)
const routeLabel = computed(() => {
  const seg = route.path.split('/').pop()
  return seg && seg !== enc.value ? seg : '概要'
})

// 专注态：sider-slot / workspace 同时带 focus 类 → v5-components 折叠左右栏
const isFocus = computed(() => focus.value && props.mode === 'edit')
</script>

<template>
  <div class="app">
    <!-- 左栏 overlay（透明浮层，内部 sider-left 白底） -->
    <aside class="sider-slot" :class="{ focus: isFocus, 'fold-l': foldL }">
      <div :class="mode === 'workbench' ? 'wb-list' : 'sider-left'">
        <BookAnchor :book-name="bookName" />
        <div class="sider-scroll">
          <OverviewNav v-if="mode === 'overview'" :book-name="bookName" />
          <FileTree v-else-if="mode === 'edit'" :book-name="bookName" />
          <TaskList v-else :book-name="bookName" />
          <Binder :book-name="bookName" />
        </div>
        <SiderFoot :book-name="bookName" @back="goShelf" @settings="showSettings = true" />
      </div>
    </aside>

    <!-- mode-tabs 居中浮（绝对定位，悬浮于 topbar） -->
    <nav class="mode-tabs">
      <div
        v-for="m in modes"
        :key="m.id"
        class="mode-tab"
        :class="{ active: mode === m.id }"
        @click="switchMode(m.id)"
      >{{ m.label }}</div>
    </nav>

    <div class="app-main">
      <header class="topbar">
        <div class="topbar-actions">
          <NTooltip trigger="hover">
            <template #trigger>
              <span class="icon-btn" @click="showPalette = true">⌘</span>
            </template>
            命令面板（⌘P）
          </NTooltip>
          <NTooltip trigger="hover">
            <template #trigger>
              <span class="icon-btn" :class="{ on: focus }" @click="toggleFocus">⤢</span>
            </template>
            专注模式（折叠左右栏）
          </NTooltip>
          <NTooltip trigger="hover">
            <template #trigger>
              <span class="icon-btn" :class="{ on: panelOpen }" @click="togglePanel">◧</span>
            </template>
            详情面板
          </NTooltip>
        </div>
      </header>

      <div class="workspace" :class="{ focus: isFocus, 'panel-closed': !panelOpen }">
        <div class="main-area">
          <main class="content">
            <div ref="contentScroll" class="content-scroll" @scroll="syncScroll">
              <slot />
            </div>
          </main>
          <aside class="sider-right">
            <div class="sider-right-head">
              <div class="sr-head-left">
                <span class="sr-eyebrow">详情</span>
                <span class="sr-title">{{ bookName }}</span>
              </div>
              <span class="sr-close" title="收起详情" @click="panelOpen = false">✕</span>
            </div>
            <div ref="siderRightInner" class="sider-right-inner">
              <DataDetail v-if="mode === 'overview'" />
              <ContextPanel v-else-if="mode === 'edit'" />
              <EventStream v-else />
            </div>
          </aside>
        </div>
      </div>

      <footer class="statusbar">
        <span class="host" :class="{ off: !serverOnline }">● {{ serverOnline ? 'Claude CLI 已连接' : 'CLI 连接中断' }}</span>
        <span>{{ modeLabel }} · {{ routeLabel }}</span>
        <div class="right"><span>{{ themeName() }}</span></div>
      </footer>
    </div>

    <SettingsModal v-model:show="showSettings" />
    <CommandPalette v-model:show="showPalette" />

    <!-- 全局操作反馈浮层（对齐 mockup .hint-tip，components.css:431） -->
    <div class="hint-tip" :class="{ show: hintState.visible }">{{ hintState.text }}</div>
  </div>
</template>

<style scoped>
/* AppShell v5：外壳结构/数值全走 v5-components.css，此处仅 v5-components 未覆盖的自有状态。 */
/* ◧ 详情面板收起走全局 .workspace.panel-closed .sider-right（components.css:328），无需 scoped。 */

/* icon-btn 激活态（focus / panel 高亮） */
.icon-btn.on {
  color: var(--ink-cyan);
  background: var(--cyan-10);
}

/* statusbar host 离线态（serverOnline=false 时） */
.host.off {
  color: var(--cinnabar);
}

/* 中栏对称：右侧常驻滚动条占空间，内容 margin:auto 居中会偏左。
   scrollbar-gutter:stable both-edges 让左右双侧预留等量 gutter，自动对称
  （比手写 padding-left 精确，不受滚动条渲染 sub-pixel 影响；替代 mockup core.js 测 sw 补偿）。 */
.content-scroll {
  scrollbar-gutter: stable both-edges;
}
</style>
