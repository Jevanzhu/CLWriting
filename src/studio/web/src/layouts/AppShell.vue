<script setup lang="ts">
// AppShell（v5）：无窗口外框——Electron 原生窗口提供交通灯/标题栏，Vue 仅应用内容。
// 顶栏(CollabBadge + mode-tabs 居中浮 + actions) + 三栏(左 overlay 贯穿 / 中居中 / 右浮层玻璃) + 容器查询响应式。
// 左栏 OverviewNav/FileTree/TaskList；右栏 DataDetail/ContextPanel/EventStream。⌘P 命令面板；⤢ 专注；◧ 面板。
// 详见 Dev/UI/Plans/桌面端与界面计划.md 第四节。
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
const focus = ref(false)     // ⤢ 专注：折叠左右栏，编辑器独占（仅编辑态）
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

/** ←书架：返回书架页（路由 /） */
function goShelf(): void {
  router.push('/')
}
const modeLabel = computed(
  () => ({ overview: '总览', edit: '编辑', workbench: '工作台' }[props.mode]),
)
const routeLabel = computed(() => {
  const seg = route.path.split('/').pop()
  return seg && seg !== enc.value ? seg : '概要'
})

const appClass = computed(() => ({
  focus: focus.value && props.mode === 'edit',
}))
</script>

<template>
  <div class="clw-desktop">
    <div class="clw-app" :class="appClass">
        <!-- 左栏 overlay 贯穿全高（贴左缘，覆盖到 topbar 上方） -->
        <aside class="clw-sider-slot">
          <BookAnchor :book-name="bookName" />
          <div class="clw-sider-body">
            <OverviewNav v-if="mode === 'overview'" :book-name="bookName" />
            <FileTree v-else-if="mode === 'edit'" :book-name="bookName" />
            <TaskList v-else />
            <Binder :book-name="bookName" />
          </div>
          <SiderFoot :book-name="bookName" @back="goShelf" @settings="showSettings = true" />
        </aside>

        <!-- mode-tabs 居中浮（绝对定位，悬浮于 topbar） -->
        <nav class="clw-mode-tabs">
          <div
            v-for="m in modes"
            :key="m.id"
            class="clw-mode-tab"
            :class="{ active: mode === m.id }"
            @click="switchMode(m.id)"
          >{{ m.label }}</div>
        </nav>

        <div class="clw-app-main">
          <!-- 顶栏：左 CollabBadge / 右 actions（mode-tabs 绝对居中浮于上方） -->
          <header class="clw-topbar">
            <div class="clw-tb-left">
              <CollabBadge :book-name="bookName" :mode="mode" />
            </div>
            <div class="clw-actions">
              <NTooltip trigger="hover">
                <template #trigger>
                  <span class="clw-icon-btn" @click="showPalette = true">⌘</span>
                </template>
                命令面板（⌘P）
              </NTooltip>
              <NTooltip trigger="hover">
                <template #trigger>
                  <span class="clw-icon-btn" :class="{ on: focus }" @click="focus = !focus">⤢</span>
                </template>
                专注模式（折叠左右栏）
              </NTooltip>
              <NTooltip trigger="hover">
                <template #trigger>
                  <span class="clw-icon-btn" :class="{ on: panelOpen }" @click="panelOpen = !panelOpen">◧</span>
                </template>
                详情面板
              </NTooltip>
              <NTooltip trigger="hover">
                <template #trigger>
                  <span class="clw-icon-btn" @click="showSettings = true">⚙</span>
                </template>
                设置
              </NTooltip>
            </div>
          </header>

          <!-- workspace：content 居中 + sider-right 浮层 -->
          <div class="clw-workspace" :class="{ 'panel-closed': !panelOpen }">
            <main class="clw-content">
              <slot />
            </main>
            <aside class="clw-aside">
              <div class="clw-sider-body">
                <DataDetail v-if="mode === 'overview'" />
                <ContextPanel v-else-if="mode === 'edit'" />
                <EventStream v-else />
              </div>
            </aside>
          </div>

          <footer class="clw-statusbar">
            <span class="clw-host">● claude CLI 已连接</span>
            <span>{{ modeLabel }} · {{ routeLabel }}</span>
            <div class="clw-status-right"><span>{{ themeName() }}</span></div>
          </footer>
        </div>
      </div>

      <SettingsModal v-model:show="showSettings" />
      <CommandPalette v-model:show="showPalette" />
    </div>
</template>

<style scoped>
/* ===== v5 外壳：无窗口外框（Electron 原生窗口提供交通灯/标题栏/边框）===== */
.clw-desktop{width:100%;height:100vh;display:flex;flex-direction:column;overflow:hidden;background:var(--canvas)}

/* ===== app：容器查询基准 ===== */
.clw-app{flex:1;display:flex;position:relative;container-type:inline-size;min-height:0}

/* 左栏 overlay 贯穿全高（贴左缘） */
.clw-sider-slot{position:absolute;left:0;top:0;bottom:0;width:var(--sider-left-w,280px);z-index:20;display:flex;flex-direction:column;overflow:hidden;background:var(--panel);border-right:1px solid var(--white-14);transition:transform .25s ease,opacity .2s ease}

/* mode-tabs 居中浮（绝对定位，悬浮于 topbar） */
.clw-mode-tabs{position:absolute;left:50%;top:10px;transform:translateX(-50%);display:flex;gap:3px;background:var(--hover);border-radius:9px;padding:3px;z-index:30}
.clw-mode-tab{padding:5px 15px;color:var(--text-2);cursor:pointer;border-radius:7px;font-size:13px;font-weight:600;user-select:none;transition:color .12s,background .12s}
.clw-mode-tab:hover{color:var(--ink)}
.clw-mode-tab.active{background:var(--panel);color:var(--ink-cyan)}

/* app-main：让出左栏宽度（sider overlay 占位） */
.clw-app-main{flex:1;display:flex;flex-direction:column;min-width:0;min-height:0;padding-left:var(--sider-left-w,280px);transition:padding-left .25s ease}

/* 顶栏：左 CollabBadge / 右 actions */
.clw-topbar{height:48px;display:flex;align-items:stretch;background:var(--panel-70);backdrop-filter:blur(14px);-webkit-backdrop-filter:blur(14px);flex-shrink:0}
.clw-tb-left{display:flex;align-items:center;padding:0 16px}
.clw-actions{display:flex;align-items:center;gap:6px;margin-left:auto;padding:0 16px}
.clw-icon-btn{height:28px;min-width:28px;padding:0 9px;display:inline-flex;align-items:center;justify-content:center;border-radius:7px;color:var(--text-2);cursor:pointer;font-size:14px;border:1px solid transparent;transition:background .12s,color .12s}
.clw-icon-btn:hover{background:var(--hover);color:var(--ink)}
.clw-icon-btn.on{color:var(--ink-cyan);background:var(--cyan-10)}

/* workspace：content + 右栏浮层 */
.clw-workspace{flex:1;display:flex;background:var(--paper);min-height:0;position:relative}
.clw-content{flex:1;display:flex;flex-direction:column;min-width:0;overflow-y:auto;padding-right:calc(var(--sider-right-w,260px) + 36px);transition:padding-right .25s ease}

/* 右栏 overlay 浮层（玻璃） */
.clw-aside{position:absolute;right:20px;top:36px;bottom:24px;width:var(--sider-right-w,260px);z-index:20;display:flex;flex-direction:column;overflow:hidden;background:var(--panel-62);backdrop-filter:blur(16px) saturate(1.3);-webkit-backdrop-filter:blur(16px) saturate(1.3);border:1px solid var(--white-22);border-radius:14px;transition:transform .25s ease,opacity .2s ease}
.clw-workspace.panel-closed .clw-aside{transform:translateX(120%);opacity:0;pointer-events:none}
.clw-workspace.panel-closed .clw-content{padding-right:36px}

.clw-sider-body{flex:1;overflow-y:auto;padding:10px 8px;display:flex;flex-direction:column;gap:14px}

.clw-statusbar{height:28px;background:var(--panel);border-top:1px solid var(--border);display:flex;align-items:center;padding:0 16px;font-size:11px;color:var(--text-2);gap:16px;flex-shrink:0}
.clw-host{color:var(--ink-cyan)}
.clw-status-right{margin-left:auto}

/* 专注模式：折叠左右栏（仅编辑态） */
.clw-app.focus .clw-sider-slot{transform:translateX(-100%);opacity:0;pointer-events:none}
.clw-app.focus .clw-aside{transform:translateX(120%);opacity:0;pointer-events:none}
.clw-app.focus .clw-app-main{padding-left:0}
.clw-app.focus .clw-content{padding-right:36px}

/* 容器查询响应式：窄窗（≤1200px）折叠左右栏，content 全宽 */
@container(max-width:1200px){
  .clw-sider-slot{transform:translateX(-100%);opacity:0;pointer-events:none}
  .clw-aside{transform:translateX(120%);opacity:0;pointer-events:none}
  .clw-app-main{padding-left:0}
  .clw-content{padding-right:36px}
}
</style>
