<script setup lang="ts">
// 自定义窗口标题栏（对齐 mockup .window-chrome）。
// Electron titleBarStyle:'hiddenInset' 隐藏原生标题文字，macOS 交通灯由系统提供（左侧 inset），Vue 不画 wc-dot。
// 居中 wc-title：进书态「书名·类型·字数」/ 入口态「当前书库名」。右 topbar-cli：CLI 连接徽章（可点击）。
import { ref, computed, watch, onMounted } from 'vue'
import { useRoute } from 'vue-router'
import { serverOnline } from '../composables/useHeartbeat'
import { useHint } from '../composables/useHint'
import { getOverview } from '../api/books'
import type { BookOverview } from '../types'

const route = useRoute()
const { hint } = useHint()
const desktop = window.clwritingDesktop ?? null

const bookName = computed(() => (route.params.name as string) || '')
const inBook = computed(() => !!bookName.value)

/** 当前书库名（desktop IPC：workDir basename；web 无 desktop → 空） */
const currentLib = ref<string | null>(null)
async function loadLib(): Promise<void> {
  if (!desktop) return
  try {
    currentLib.value = await desktop.getCurrentLibrary()
  } catch {
    /* preload 失败静默 */
  }
}
const libName = computed(() => {
  if (!currentLib.value) return ''
  const seg = currentLib.value.split(/[/\\]/).filter(Boolean)
  return seg[seg.length - 1] ?? currentLib.value
})

/** 进书态书信息（getOverview：kind + progress.words） */
const ov = ref<BookOverview | null>(null)
async function loadOverview(): Promise<void> {
  if (!bookName.value) {
    ov.value = null
    return
  }
  try {
    ov.value = await getOverview(bookName.value)
  } catch {
    ov.value = null
  }
}
watch(bookName, () => loadOverview(), { immediate: true })

/** 字数万化（≥1万显示 x.x万）——与 BookAnchor 一致 */
function wn(w: number): string {
  return w >= 10000 ? (w / 10000).toFixed(1) + '万' : String(w)
}
const bookKindLabel = computed(() =>
  (ov.value?.identity.kind ?? 'long') === 'short' ? '短篇集' : '长篇',
)
const bookWordsLabel = computed(() => (ov.value ? wn(ov.value.progress.words) : '—'))

/** CLI 徽章点击：真实 CLI 状态不可手动切换，给 hint 提示当前态 */
function onCliClick(): void {
  hint(
    serverOnline.value
      ? 'Claude CLI 已连接 · AI 步可用'
      : 'CLI 连接中断 · AI 步暂不可用，请检查 claude 命令是否可用',
  )
}

onMounted(loadLib)
</script>

<template>
  <div class="window-chrome">
    <!-- 居中：进书态书信息（书名先行，ov 到位后补类型·字数）/ 入口态书库名 -->
    <span class="wc-title">
      <template v-if="inBook">
        <span class="wt-name">{{ bookName }}</span>
        <template v-if="ov">
          <span class="wt-sep">·</span>
          <span class="wt-meta">{{ bookKindLabel }}</span>
          <span class="wt-sep">·</span>
          <span class="wt-meta">{{ bookWordsLabel }}字</span>
        </template>
      </template>
      <span v-else-if="libName" class="wt-name">{{ libName }}</span>
      <span v-else class="wt-name">CLWriting Studio</span>
    </span>
    <!-- 右：CLI 连接徽章（mockup topbar-cli；serverOnline 心跳驱动）-->
    <span
      class="topbar-cli wc-cli"
      :class="{ off: !serverOnline }"
      :title="serverOnline ? 'Claude CLI 已连接' : 'CLI 连接中断 · AI 步暂不可用'"
      @click="onCliClick"
    >
      <span class="cli-dot"></span>{{ serverOnline ? 'Claude CLI' : '未连接' }}
    </span>
  </div>
</template>

<style scoped>
/* .window-chrome / .wc-title / .wt-* / .topbar-cli 全局已定义（v5-components.css line 491-500）。
   此处仅补：拖拽区（整栏可拖拽移动窗口）+ CLI 徽章 no-drag 可点击。 */
.window-chrome {
  -webkit-app-region: drag;
  padding-right: 4px; /* CLI 徽章接近右边框 */
}
.wc-cli {
  -webkit-app-region: no-drag;
  cursor: pointer;
}
</style>
