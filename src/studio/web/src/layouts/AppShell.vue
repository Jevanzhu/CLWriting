<script setup lang="ts">
// AppShell：顶栏(mode-tabs) + 三栏 workspace(独立成页) + 状态栏 + 设置弹层 + 命令面板。
// 左栏 OverviewNav/FileTree/TaskList；右栏 DataDetail/ContextPanel/EventStream。
// ⌘P 唤起命令面板。详见 Dev/Plans/桌面端与界面计划.md 第六节。
import { computed, ref, onMounted, onUnmounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { NButton, NTooltip } from 'naive-ui'
import { useTheme } from '../composables/useTheme'
import { useHeartbeat } from '../composables/useHeartbeat'
import OverviewNav from '../components/OverviewNav.vue'
import FileTree from '../components/FileTree.vue'
import TaskList from '../components/TaskList.vue'
import DataDetail from '../components/DataDetail.vue'
import ContextPanel from '../components/ContextPanel.vue'
import EventStream from '../components/EventStream.vue'
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
const { theme, cycleTheme, themeName } = useTheme()

const enc = computed(() => (props.bookName ? encodeURIComponent(props.bookName) : ''))

// 1.5 单写者协作心跳（原 BookTabs，迁入常驻 shell）
useHeartbeat(() => enc.value)

const showSettings = ref(false)
const showPalette = ref(false)

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

const siderTitle = computed(
  () => ({ overview: '总览 · 导航', edit: '文件 · 观微', workbench: '任务 · 观微' }[props.mode]),
)
const asideTitle = computed(() => ({ overview: '数据明细', edit: '上下文', workbench: '事件流' }[props.mode]))
const modeLabel = computed(() => ({ overview: '总览', edit: '编辑', workbench: '工作台' }[props.mode]))
const routeLabel = computed(() => {
  const seg = route.path.split('/').pop()
  return seg && seg !== enc.value ? seg : '概要'
})
</script>

<template>
  <div class="clw-app">
    <!-- 顶栏 -->
    <header class="clw-topbar">
      <div class="clw-logo">墨</div>
      <div class="clw-brand">CLWriting</div>
      <div class="clw-vault">书库 · <b>{{ bookName || '—' }}</b></div>
      <CollabBadge :book-name="bookName" :mode="mode" />

      <nav class="clw-mode-tabs">
        <div
          v-for="m in modes"
          :key="m.id"
          class="clw-mode-tab"
          :class="{ active: mode === m.id }"
          @click="switchMode(m.id)"
        >{{ m.label }}</div>
      </nav>

      <div class="clw-actions">
        <span class="clw-cmd" @click="showPalette = true">⌘P 命令面板</span>
        <NTooltip trigger="hover">
          <template #trigger>
            <NButton quaternary size="small" @click="cycleTheme()">☾ {{ themeName() }}</NButton>
          </template>
          切换主题（当前：{{ themeName() }}）
        </NTooltip>
        <NTooltip trigger="hover">
          <template #trigger>
            <NButton quaternary size="small" @click="showSettings = true">⚙</NButton>
          </template>
          设置
        </NTooltip>
      </div>
    </header>

    <!-- 三栏 workspace：canvas 底 + 三 panel 圆角阴影 + 8px gap -->
    <div class="clw-workspace">
      <aside class="clw-sider clw-panel">
        <div class="clw-sider-head">{{ siderTitle }}</div>
        <div class="clw-sider-body">
          <OverviewNav v-if="mode === 'overview'" :book-name="bookName" />
          <FileTree v-else-if="mode === 'edit'" :book-name="bookName" />
          <TaskList v-else />
        </div>
      </aside>

      <main class="clw-content clw-panel">
        <slot />
      </main>

      <aside class="clw-aside clw-panel">
        <div class="clw-sider-head">{{ asideTitle }}</div>
        <div class="clw-sider-body">
          <DataDetail v-if="mode === 'overview'" />
          <ContextPanel v-else-if="mode === 'edit'" />
          <EventStream v-else />
        </div>
      </aside>
    </div>

    <SettingsModal v-model:show="showSettings" />
    <CommandPalette v-model:show="showPalette" />

    <footer class="clw-statusbar">
      <span class="clw-host">● claude CLI 已连接</span>
      <span>{{ modeLabel }} · {{ routeLabel }}</span>
      <div class="clw-status-right">
        <span>{{ themeName() }}</span>
      </div>
    </footer>
  </div>
</template>

<style scoped>
.clw-app {
  display: flex;
  flex-direction: column;
  height: 100vh;
}

.clw-topbar {
  height: 46px;
  display: flex;
  align-items: center;
  gap: 14px;
  background: var(--panel);
  border-bottom: 1px solid var(--border);
  padding: 0 12px;
  flex-shrink: 0;
}
.clw-logo {
  width: 30px;
  height: 30px;
  background: var(--brand);
  color: #fff;
  border-radius: 7px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-family: 'STKaiti', 'KaiTi', '楷体', serif;
  font-size: 18px;
  font-weight: 700;
  flex-shrink: 0;
}
.clw-brand {
  font-size: 13px;
  font-weight: 600;
  letter-spacing: 0.5px;
}
.clw-vault {
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--text-2);
  font-size: 12px;
  padding-left: 12px;
  border-left: 1px solid var(--border);
}
.clw-vault b {
  color: var(--ink);
  font-weight: 600;
}
.clw-mode-tabs {
  display: flex;
  gap: 4px;
  margin-left: 18px;
  height: 30px;
  align-items: center;
  background: var(--hover);
  border-radius: 8px;
  padding: 3px;
}
.clw-mode-tab {
  padding: 4px 14px;
  color: var(--text-2);
  cursor: pointer;
  border-radius: 6px;
  font-size: 13px;
  user-select: none;
}
.clw-mode-tab:hover {
  color: var(--ink);
}
.clw-mode-tab.active {
  color: var(--ink);
  background: var(--panel);
  font-weight: 600;
  box-shadow: var(--shadow);
}
.clw-actions {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-left: auto;
  padding-left: 12px;
}
.clw-cmd {
  font-size: 11px;
  color: var(--text-3);
  border: 1px solid var(--border);
  border-radius: 5px;
  padding: 3px 7px;
  cursor: pointer;
}
.clw-cmd:hover {
  color: var(--ink-cyan);
  border-color: var(--ink-cyan);
}

.clw-workspace {
  flex: 1;
  display: flex;
  gap: 8px;
  padding: 8px;
  background: var(--canvas);
  min-height: 0;
}
.clw-sider {
  width: 222px;
  display: flex;
  flex-direction: column;
  flex-shrink: 0;
}
.clw-aside {
  width: 296px;
  display: flex;
  flex-direction: column;
  flex-shrink: 0;
}
.clw-content {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-width: 0;
  background: var(--paper);
  overflow-y: auto;
}

.clw-sider-head {
  height: 36px;
  display: flex;
  align-items: center;
  padding: 0 14px;
  color: var(--text-3);
  font-size: 11px;
  letter-spacing: 1px;
  text-transform: uppercase;
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
}
.clw-sider-body {
  flex: 1;
  overflow-y: auto;
  padding: 12px 14px;
}

.clw-statusbar {
  height: 28px;
  background: var(--panel);
  border-top: 1px solid var(--border);
  display: flex;
  align-items: center;
  padding: 0 14px;
  font-size: 11px;
  color: var(--text-2);
  gap: 16px;
  flex-shrink: 0;
}
.clw-host {
  color: var(--ink-cyan);
}
.clw-status-right {
  margin-left: auto;
}
</style>
