<script setup lang="ts">
// 书库管理页（独立窗口 /library?win=library）：
// 当前书库（路径 + 打开目录）+ 最近列表（切换→relaunch）+ 选择目录（新建/切换）。
// 仅桌面版（window.clwritingDesktop）；浏览器版显示提示。
import { ref, onMounted } from 'vue'
import { FolderOpen, ExternalLink, Database, ArrowRight, Check } from 'lucide-vue-next'

const hasDesktop = !!window.clwritingDesktop
const current = ref<string | null>(null)
const recents = ref<{ path: string; label: string }[]>([])
const loading = ref(true)

onMounted(async () => {
  if (!hasDesktop) {
    loading.value = false
    return
  }
  const [cur, rec] = await Promise.all([
    window.clwritingDesktop!.getCurrentLibrary(),
    window.clwritingDesktop!.getRecentLibraries(),
  ])
  current.value = cur
  recents.value = rec
  loading.value = false
})

// 选择目录（弹原生选择器；含非书库目录二次确认新建流程 → relaunch）
async function chooseLibrary(): Promise<void> {
  await window.clwritingDesktop?.openLibrary()
}

// 切换到最近列表中的书库 → relaunch
async function switchTo(path: string): Promise<void> {
  if (path === current.value) return
  await window.clwritingDesktop?.switchLibrary(path)
}

// 在文件管理器中打开当前书库根目录
function openDir(): void {
  void window.clwritingDesktop?.openLibraryDir()
}
</script>

<template>
  <div class="library" :class="{ 'has-traffic': hasDesktop }">
    <header class="lib-titlebar" />
    <main class="lib-main">
      <header class="lib-head">
        <div class="head-left">
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
      <template v-else>
        <section v-if="current" class="current-card">
          <div class="cur-icon"><Database :size="20" /></div>
          <div class="cur-info">
            <span class="cur-label">当前书库</span>
            <p class="cur-path" :title="current">{{ current }}</p>
          </div>
          <button class="btn icon" title="在文件管理器中打开" @click="openDir">
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
  min-height: 100vh;
  display: flex;
  flex-direction: column;
  background: var(--background-primary);
}
/* 顶部 titlebar：窗口拖动区（桌面版），避让 macOS 交通灯 */
.lib-titlebar {
  height: var(--size-tabbar);
  flex-shrink: 0;
  border-bottom: 1px solid var(--background-modifier-border);
  background: var(--background-primary);
}
.library.has-traffic .lib-titlebar {
  -webkit-app-region: drag;
}
.lib-main {
  flex: 1;
  width: 100%;
  max-width: 640px;
  margin: 0 auto;
  padding: var(--size-4-8) var(--size-4-6) var(--size-4-10);
}
.lib-head {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: var(--size-4-4);
  margin-bottom: var(--size-4-6);
}
.head-left {
  display: flex;
  flex-direction: column;
  gap: var(--size-4-1);
}
.head-title {
  margin: 0;
  font-size: var(--font-size-2xl);
  font-weight: 700;
  letter-spacing: -0.03em;
  line-height: 1.1;
  color: var(--text-normal);
}
.head-sub {
  margin: 0;
  font-size: var(--font-size-s);
  color: var(--text-muted);
}
.btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 7px 14px;
  border: 1px solid var(--background-modifier-border);
  border-radius: var(--radius-s);
  background: var(--interactive-normal);
  color: var(--text-normal);
  font-size: 13px;
  cursor: pointer;
}
.btn.icon {
  padding: 7px;
}
.btn:hover:not(:disabled) {
  background: var(--interactive-hover);
}
.btn.primary {
  background: var(--interactive-accent);
  border-color: var(--interactive-accent);
  color: var(--text-on-accent);
}
.btn.primary:hover:not(:disabled) {
  background: var(--interactive-accent-hover);
}
.lib-status {
  padding: var(--size-4-10) 0;
  text-align: center;
  color: var(--text-muted);
}

/* 当前书库卡片：图标 + 路径 + 打开目录 */
.current-card {
  display: flex;
  align-items: center;
  gap: var(--size-4-3);
  padding: var(--size-4-4);
  margin-bottom: var(--size-4-6);
  border-radius: var(--radius-m);
  background: linear-gradient(135deg, var(--background-secondary-alt), var(--background-secondary));
  border: 1px solid var(--background-modifier-border);
  box-shadow: var(--shadow-s);
}
.cur-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
  flex-shrink: 0;
  border-radius: var(--radius-s);
  background: color-mix(in srgb, var(--text-accent) 12%, transparent);
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

/* 最近列表 */
.recent-section {
  display: flex;
  flex-direction: column;
  gap: var(--size-4-3);
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
  border-radius: var(--radius-s);
  background: transparent;
  color: var(--text-normal);
  cursor: pointer;
  text-align: left;
  transition: background var(--dur-fast) var(--ease-out);
}
.recent-item:hover {
  background: var(--background-modifier-hover);
}
.recent-item.active {
  background: color-mix(in srgb, var(--text-accent) 8%, transparent);
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
</style>
