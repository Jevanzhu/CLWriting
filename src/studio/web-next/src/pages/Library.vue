<script setup lang="ts">
// 书库管理页（独立窗口 /library?win=library）：
// 当前书库（路径 + 打开目录）+ 最近列表（切换→relaunch）+ 选择目录（新建/切换）。
// 仅桌面版（window.clwritingDesktop）；浏览器版显示提示。
import { ref, onMounted } from 'vue'
import { useUiStore } from '../stores/ui'
import { friendlyError } from '../shared/error'
import { FolderOpen, ExternalLink, Database, ArrowRight, Check } from 'lucide-vue-next'

const ui = useUiStore()

const hasDesktop = !!window.clwritingDesktop
const current = ref<string | null>(null)
const recents = ref<{ path: string; label: string }[]>([])
const loading = ref(true)
// 低级项（第六轮）：IPC 失败不再永久「加载中…」——错误态 + 重试出口
const loadError = ref<string | null>(null)

async function load(): Promise<void> {
  if (!hasDesktop) {
    loading.value = false
    return
  }
  loading.value = true
  loadError.value = null
  try {
    const [cur, rec] = await Promise.all([
      window.clwritingDesktop!.getCurrentLibrary(),
      window.clwritingDesktop!.getRecentLibraries(),
    ])
    current.value = cur
    recents.value = rec
  } catch (e) {
    loadError.value = e instanceof Error ? e.message : String(e)
  } finally {
    loading.value = false
  }
}

onMounted(() => void load())

// 选择目录（弹原生选择器；含非书库目录二次确认新建流程 → relaunch）。
// P5-前端（第七轮）：交互路径 IPC 捕获——第六轮只修了加载路径，选择/切换失败
// 原先 unhandled rejection 零反馈
async function chooseLibrary(): Promise<void> {
  try {
    await window.clwritingDesktop?.openLibrary()
  } catch (e) {
    loadError.value = e instanceof Error ? e.message : String(e)
  }
}

// 切换到最近列表中的书库 → relaunch
async function switchTo(path: string): Promise<void> {
  if (path === current.value) return
  try {
    await window.clwritingDesktop?.switchLibrary(path)
  } catch (e) {
    loadError.value = e instanceof Error ? e.message : String(e)
  }
}

// 在文件管理器中打开当前书库根目录
function openDir(): void {
  // R33D-31：IPC 失败 toast 交代
  window.clwritingDesktop?.openLibraryDir().catch((e: unknown) => ui.toast(friendlyError(e), 'error'))
}
</script>

<template>
  <div class="library" :class="{ 'has-traffic': hasDesktop }">
    <!-- 环境背景：呼吸光晕（与 Welcome 同语言） -->
    <div class="ambient">
      <div class="glow glow-tr"></div>
      <div class="glow glow-bl"></div>
    </div>

    <header class="lib-titlebar" />
    <main class="lib-main">
      <header class="lib-head">
        <div class="head-left">
          <div class="head-mark"><Database :size="24" /></div>
          <h1 class="head-title">书库</h1>
          <p class="head-sub">管理你的创作书库</p>
        </div>
        <button class="btn primary" @click="chooseLibrary">
          <FolderOpen :size="15" />
          <span>选择目录</span>
        </button>
      </header>

      <div v-if="loading" class="lib-status">加载中…</div>
      <div v-else-if="!hasDesktop" class="lib-status">
        <p>书库管理仅在桌面版可用。</p>
      </div>
      <div v-else-if="loadError" class="lib-status">
        <p>书库信息加载失败：{{ loadError }}</p>
        <button class="btn" @click="void load()">重试</button>
      </div>
      <template v-else>
        <section v-if="current" class="current-card">
          <div class="cur-icon"><Database :size="20" /></div>
          <div class="cur-info">
            <span class="cur-label">当前书库</span>
            <p class="cur-path" :title="current">{{ current }}</p>
          </div>
          <button class="btn icon" data-tip="在文件管理器中打开" @click="openDir">
            <ExternalLink :size="16" />
          </button>
        </section>

        <section class="recent-section">
          <h2 class="section-title">
            最近 <span class="count">{{ recents.length }}</span>
          </h2>
          <p v-if="!recents.length" class="empty">暂无其他书库</p>
          <ul v-else class="recent-list">
            <li v-for="r in recents" :key="r.path">
              <button
                class="recent-item"
                :class="{ active: r.path === current }"
                @click="switchTo(r.path)"
              >
                <div class="item-info">
                  <span class="item-label">{{ r.label }}</span>
                  <span class="item-path" :title="r.path">{{ r.path }}</span>
                </div>
                <Check v-if="r.path === current" :size="16" class="item-check" />
                <ArrowRight v-else :size="15" class="item-arrow" />
              </button>
            </li>
          </ul>
        </section>
      </template>
    </main>
  </div>
</template>

<style scoped>
.library {
  position: relative;
  min-height: 100vh;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background:
    linear-gradient(135deg,
      color-mix(in srgb, var(--interactive-accent) 4%, var(--background-primary)),
      var(--background-primary));
}

/* 光晕静态（opacity 固定动画中值）：无限 opacity/scale 呼吸会驱动整窗持续出帧
 * （实测闲置 GPU ~10% + renderer ~5% CPU），radial-gradient 本身已柔和，无动画必要 */

/* titlebar（拖动区，避让交通灯） */
.lib-titlebar {
  position: relative;
  z-index: 1;
  height: var(--size-tabbar);
  flex-shrink: 0;
}
.library.has-traffic .lib-titlebar {
  -webkit-app-region: drag;
}

/* 主体 */
.lib-main {
  position: relative;
  z-index: 1;
  flex: 1;
  width: 100%;
  max-width: 640px;
  margin: 0 auto;
  padding: var(--size-4-8) var(--size-4-6) var(--size-4-12);
}

/* head：徽标 + 渐变标题 + tagline */
.lib-head {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: var(--size-4-4);
  margin-bottom: var(--size-4-7);
  animation: clw-fade-up 0.5s var(--ease-out) both;
}
.head-left {
  display: flex;
  flex-direction: column;
  gap: var(--size-4-1);
}
.head-mark {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 48px;
  height: 48px;
  margin-bottom: var(--size-4-2);
  border-radius: var(--radius-m);
  background: color-mix(in srgb, var(--interactive-accent) 14%, transparent);
  color: var(--text-accent);
  box-shadow:
    0 0 0 1px color-mix(in srgb, var(--interactive-accent) 20%, transparent),
    var(--shadow-m),
    0 0 30px color-mix(in srgb, var(--interactive-accent) 18%, transparent);
}
.head-title {
  margin: 0;
  font-size: var(--font-size-2xl);
  font-weight: 800;
  letter-spacing: -0.03em;
  line-height: 1.1;
  /* 渐变标题：accent → normal */
  background: linear-gradient(135deg, var(--text-accent), var(--text-normal) 75%);
  -webkit-background-clip: text;
  background-clip: text;
  -webkit-text-fill-color: transparent;
  color: transparent;
}
.head-sub {
  margin: 0;
  font-size: var(--font-size-s);
  color: var(--text-muted);
}

/* 按钮（玻璃质感 + 主按钮签名渐变） */
.btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 7px 14px;
  border: 1px solid var(--background-modifier-border);
  border-radius: var(--radius-s);
  background: color-mix(in srgb, var(--background-primary) 72%, transparent);
  backdrop-filter: blur(8px);
  color: var(--text-normal);
  font-size: var(--font-size-m);
  cursor: pointer;
  transition: all var(--dur-fast) var(--ease-out);
}
.btn.icon {
  padding: 7px;
}
.btn:hover:not(:disabled) {
  background: var(--interactive-hover);
  border-color: var(--background-modifier-border-hover);
}
.btn.primary {
  background: linear-gradient(135deg, var(--interactive-accent), var(--interactive-accent-hover));
  border-color: transparent;
  color: var(--text-on-accent);
  box-shadow:
    var(--shadow-s),
    0 0 0 1px color-mix(in srgb, var(--interactive-accent) 24%, transparent);
}
.btn.primary:hover:not(:disabled) {
  box-shadow:
    var(--shadow-m),
    0 0 20px color-mix(in srgb, var(--interactive-accent) 28%, transparent);
}
.lib-status {
  padding: var(--size-4-10) 0;
  text-align: center;
  color: var(--text-muted);
}

/* 当前书库卡片：玻璃质感 */
.current-card {
  display: flex;
  align-items: center;
  gap: var(--size-4-3);
  padding: var(--size-4-4);
  margin-bottom: var(--size-4-6);
  border-radius: var(--radius-l);
  background: color-mix(in srgb, var(--background-primary) 72%, transparent);
  backdrop-filter: blur(10px);
  border: 1px solid var(--background-modifier-border);
  box-shadow: var(--shadow-s);
  animation: clw-fade-up 0.5s var(--ease-out) 60ms both;
}
.cur-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 40px;
  height: 40px;
  flex-shrink: 0;
  border-radius: var(--radius-m);
  background: color-mix(in srgb, var(--interactive-accent) 12%, transparent);
  color: var(--text-accent);
}
.cur-info {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.cur-label {
  font-size: var(--font-size-xs);
  color: var(--text-faint);
  letter-spacing: 0.04em;
}
.cur-path {
  margin: 0;
  font-size: var(--font-size-s);
  color: var(--text-normal);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  font-family: var(--font-monospace, ui-monospace, monospace);
}

/* 最近列表：书脊意象（左 3px 竖条 hover/active 亮起） */
.recent-section {
  display: flex;
  flex-direction: column;
  gap: var(--size-4-3);
  animation: clw-fade-up 0.5s var(--ease-out) 120ms both;
}
.section-title {
  margin: 0;
  font-size: var(--font-size-m);
  font-weight: 600;
  color: var(--text-normal);
  display: flex;
  align-items: baseline;
  gap: var(--size-4-2);
}
.count {
  font-size: var(--font-size-xs);
  color: var(--text-faint);
  font-variant-numeric: tabular-nums;
  font-weight: 400;
}
.empty {
  margin: 0;
  padding: var(--size-4-6) 0;
  text-align: center;
  font-size: var(--font-size-s);
  color: var(--text-faint);
}
.recent-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.recent-item {
  display: flex;
  align-items: center;
  gap: var(--size-4-3);
  width: 100%;
  padding: var(--size-4-3) var(--size-4-4);
  border: none;
  border-left: 3px solid transparent;
  border-radius: 0 var(--radius-s) var(--radius-s) 0;
  background: transparent;
  color: var(--text-normal);
  cursor: pointer;
  text-align: left;
  transition:
    background var(--dur-fast) var(--ease-out),
    border-color var(--dur-fast) var(--ease-out);
}
.recent-item:hover {
  background: var(--background-modifier-hover);
  border-left-color: var(--interactive-accent);
}
.recent-item.active {
  background: color-mix(in srgb, var(--interactive-accent) 8%, transparent);
  border-left-color: var(--interactive-accent);
}
.item-info {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 1px;
}
.item-label {
  font-size: var(--font-size-m);
  font-weight: 500;
  color: var(--text-normal);
}
.item-path {
  font-size: var(--font-size-xs);
  color: var(--text-faint);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  font-family: var(--font-monospace, ui-monospace, monospace);
}
.item-check {
  color: var(--text-accent);
  flex-shrink: 0;
}
.item-arrow {
  color: var(--text-faint);
  flex-shrink: 0;
  opacity: 0;
  transition: opacity var(--dur-fast) var(--ease-out);
}
.recent-item:hover .item-arrow {
  opacity: 1;
}

/* 入场动画 */

</style>
