<script setup lang="ts">
// AppShell（v5 照搬）：Electron 原生窗口提供交通灯/标题栏，Vue 仅 .app 应用内容。
// 结构/数值全走 v5-components.css（.app/.sider-slot/.sider-left/.topbar/.workspace/.content/.sider-right/.mode-tabs/.statusbar）。
// 三栏纯 overlay：左 sider-slot 浮左空白 / 中 content 居中(max-width) / 右 sider-right 浮右空白；窄窗容器查询折叠。
import { computed, ref, onMounted, onUnmounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { NTooltip } from 'naive-ui'
import { useTheme } from '../composables/useTheme'
import { useHeartbeat } from '../composables/useHeartbeat'
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
import CollabBadge from '../components/CollabBadge.vue'

type Mode = 'overview' | 'edit' | 'workbench'

const props = defineProps<{
  mode: Mode
  bookName?: string
}>()

const route = useRoute()
const router = useRouter()
const { themeName } = useTheme()

const enc = computed(() => (props.bookName ? encodeURIComponent(props.bookName) : ''))

// 1.5 单写者协作心跳（常驻 shell）
useHeartbeat(() => enc.value)

const showSettings = ref(false)
const showPalette = ref(false)
const focus = ref(false)     // ⤢ 专注：折叠左右栏（仅编辑态）
const panelOpen = ref(true)  // ◧ 详情面板：右栏开关

// ⌘P 唤起命令面板（全局键盘监听）
function onGlobalKey(e: KeyboardEvent): void {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'p') {
    e.preventDefault()
    showPalette.value = true
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
    <aside class="sider-slot" :class="{ focus: isFocus }">
      <div class="sider-left">
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
        <div class="topbar-main">
          <CollabBadge :book-name="bookName" :mode="mode" />
        </div>
        <div class="topbar-actions">
          <NTooltip trigger="hover">
            <template #trigger>
              <span class="icon-btn" @click="showPalette = true">⌘</span>
            </template>
            命令面板（⌘P）
          </NTooltip>
          <NTooltip trigger="hover">
            <template #trigger>
              <span class="icon-btn" :class="{ on: focus }" @click="focus = !focus">⤢</span>
            </template>
            专注模式（折叠左右栏）
          </NTooltip>
          <NTooltip trigger="hover">
            <template #trigger>
              <span class="icon-btn" :class="{ on: panelOpen }" @click="panelOpen = !panelOpen">◧</span>
            </template>
            详情面板
          </NTooltip>
          <NTooltip trigger="hover">
            <template #trigger>
              <span class="icon-btn" @click="showSettings = true">⚙</span>
            </template>
            设置
          </NTooltip>
        </div>
      </header>

      <div class="workspace" :class="{ focus: isFocus, 'panel-open': panelOpen }">
        <main class="content">
          <div class="content-scroll">
            <slot />
          </div>
        </main>
        <aside class="sider-right">
          <div class="sider-right-inner">
            <DataDetail v-if="mode === 'overview'" />
            <ContextPanel v-else-if="mode === 'edit'" />
            <EventStream v-else />
          </div>
        </aside>
      </div>

      <footer class="statusbar">
        <span class="host">● claude CLI 已连接</span>
        <span>{{ modeLabel }} · {{ routeLabel }}</span>
        <div class="status-right"><span>{{ themeName() }}</span></div>
      </footer>
    </div>

    <SettingsModal v-model:show="showSettings" />
    <CommandPalette v-model:show="showPalette" />
  </div>
</template>

<style scoped>
/* AppShell v5：外壳结构/数值全走 v5-components.css，此处仅 v5-components 未覆盖的自有状态。 */

/* ◧ 详情面板开关（mockup 无此 toggle，AppShell 自有）：关时右栏滑出 */
.workspace:not(.panel-open) .sider-right {
  transform: translateX(100%);
  opacity: 0;
  pointer-events: none;
}

/* icon-btn 激活态（focus / panel 高亮） */
.icon-btn.on {
  color: var(--ink-cyan);
  background: var(--cyan-10);
}

.status-right {
  margin-left: auto;
}
</style>
