<script setup lang="ts">
// 起始页（主窗口 /welcome）：APP 首次启动 / 书库失效时加载。
// 引导用户新建书库或打开已有书库；提供最近书库快捷切换。全部走现有桌面 IPC。
import { ref, onMounted } from 'vue'
import { Sparkles, FolderOpen, BookOpen, ArrowRight, Clock } from 'lucide-vue-next'

const hasDesktop = !!window.clwritingDesktop
const recents = ref<{ path: string; label: string }[]>([])
const loading = ref(true)

onMounted(async () => {
  if (!hasDesktop) {
    loading.value = false
    return
  }
  recents.value = await window.clwritingDesktop!.getRecentLibraries()
  loading.value = false
})

// 新建 / 打开共用同一 IPC：pickLibrary 融合逻辑（是书库→直接用；空目录→问是否新建）
async function chooseLibrary(): Promise<void> {
  await window.clwritingDesktop?.openLibrary()
}

async function switchTo(path: string): Promise<void> {
  await window.clwritingDesktop?.switchLibrary(path)
}
</script>

<template>
  <div class="welcome" :class="{ 'has-traffic': hasDesktop }">
    <header class="welcome-titlebar" />
    <main class="welcome-stage">
      <div class="brand">
        <div class="brand-mark"><BookOpen :size="28" /></div>
        <h1 class="brand-name">CLWriting</h1>
        <p class="brand-tagline">选择一个书库目录，开启你的长篇创作之旅</p>
      </div>

      <div v-if="!hasDesktop && !loading" class="entries">
        <p class="no-desktop">书库管理仅在桌面版可用。请使用 CLWriting 桌面应用启动。</p>
      </div>

      <div v-else class="entries">
        <button class="entry" @click="chooseLibrary">
          <div class="entry-icon create"><Sparkles :size="24" /></div>
          <div class="entry-text">
            <span class="entry-title">新建书库</span>
            <span class="entry-desc">选择一个空目录，建立全新的创作空间</span>
          </div>
          <ArrowRight :size="18" class="entry-arrow" />
        </button>

        <button class="entry" @click="chooseLibrary">
          <div class="entry-icon open"><FolderOpen :size="24" /></div>
          <div class="entry-text">
            <span class="entry-title">打开已有书库</span>
            <span class="entry-desc">选择一个包含 .clwriting 的目录继续创作</span>
          </div>
          <ArrowRight :size="18" class="entry-arrow" />
        </button>
      </div>

      <section v-if="hasDesktop && recents.length" class="recent">
        <h2 class="recent-title">
          <Clock :size="14" />
          <span>最近打开</span>
        </h2>
        <ul class="recent-list">
          <li v-for="r in recents" :key="r.path">
            <button class="recent-item" @click="switchTo(r.path)">
              <div class="recent-info">
                <span class="recent-label">{{ r.label }}</span>
                <span class="recent-path" :title="r.path">{{ r.path }}</span>
              </div>
              <ArrowRight :size="15" class="recent-arrow" />
            </button>
          </li>
        </ul>
      </section>
    </main>
  </div>
</template>

<style scoped>
.welcome {
  min-height: 100vh;
  display: flex;
  flex-direction: column;
  background:
    radial-gradient(ellipse 80% 50% at 50% 0%, color-mix(in srgb, var(--text-accent) 6%, transparent), transparent),
    var(--background-primary);
}
.welcome-titlebar {
  height: var(--size-tabbar);
  flex-shrink: 0;
}
.welcome.has-traffic .welcome-titlebar {
  -webkit-app-region: drag;
}
.welcome-stage {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--size-4-10);
  padding: var(--size-4-6) var(--size-4-6) var(--size-4-12);
  max-width: 720px;
  margin: 0 auto;
  width: 100%;
}

/* 品牌 */
.brand {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--size-4-3);
}
.brand-mark {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 56px;
  height: 56px;
  border-radius: var(--radius-m);
  background: color-mix(in srgb, var(--text-accent) 12%, transparent);
  color: var(--text-accent);
  box-shadow: var(--shadow-s);
}
.brand-name {
  margin: 0;
  font-size: 28px;
  font-weight: 800;
  letter-spacing: -0.04em;
  line-height: 1;
  color: var(--text-normal);
}
.brand-tagline {
  margin: 0;
  font-size: var(--font-size-m);
  color: var(--text-muted);
  text-align: center;
}

/* 入口卡片 */
.entries {
  display: flex;
  flex-direction: column;
  gap: var(--size-4-3);
  width: 100%;
  max-width: 480px;
}
.no-desktop {
  margin: 0;
  padding: var(--size-4-8) var(--size-4-4);
  text-align: center;
  font-size: var(--font-size-m);
  color: var(--text-muted);
  border: 1px dashed var(--background-modifier-border);
  border-radius: var(--radius-m);
}
.entry {
  display: flex;
  align-items: center;
  gap: var(--size-4-4);
  width: 100%;
  padding: var(--size-4-5) var(--size-4-6);
  border: 1px solid var(--background-modifier-border);
  border-radius: var(--radius-m);
  background: var(--background-primary);
  color: var(--text-normal);
  cursor: pointer;
  text-align: left;
  transition:
    transform var(--dur-fast) var(--ease-out),
    box-shadow var(--dur-fast) var(--ease-out),
    border-color var(--dur-fast) var(--ease-out);
}
.entry:hover {
  transform: translateY(-2px);
  box-shadow: var(--shadow-l);
  border-color: color-mix(in srgb, var(--text-accent) 35%, transparent);
}
.entry-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 44px;
  height: 44px;
  flex-shrink: 0;
  border-radius: var(--radius-s);
}
.entry-icon.create {
  background: color-mix(in srgb, var(--text-accent) 12%, transparent);
  color: var(--text-accent);
}
.entry-icon.open {
  background: var(--background-secondary-alt);
  color: var(--text-muted);
}
.entry-text {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.entry-title {
  font-size: var(--font-size-l);
  font-weight: 600;
  color: var(--text-normal);
}
.entry-desc {
  font-size: var(--font-size-s);
  color: var(--text-faint);
}
.entry-arrow {
  color: var(--text-faint);
  flex-shrink: 0;
  opacity: 0;
  transform: translateX(-4px);
  transition: opacity var(--dur-fast) var(--ease-out), transform var(--dur-fast) var(--ease-out);
}
.entry:hover .entry-arrow {
  opacity: 1;
  transform: translateX(0);
}

/* 最近列表 */
.recent {
  width: 100%;
  max-width: 480px;
  display: flex;
  flex-direction: column;
  gap: var(--size-4-2);
}
.recent-title {
  margin: 0;
  font-size: var(--font-size-xs);
  font-weight: 500;
  color: var(--text-faint);
  letter-spacing: 0.06em;
  text-transform: uppercase;
  display: flex;
  align-items: center;
  gap: 6px;
  padding-left: var(--size-4-2);
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
  padding: var(--size-4-2) var(--size-4-3);
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
.recent-info {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 1px;
}
.recent-label {
  font-size: var(--font-size-m);
  font-weight: 500;
}
.recent-path {
  font-size: var(--font-size-xs);
  color: var(--text-faint);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  font-family: var(--font-monospace, ui-monospace, monospace);
}
.recent-arrow {
  color: var(--text-faint);
  flex-shrink: 0;
  opacity: 0;
  transition: opacity var(--dur-fast) var(--ease-out);
}
.recent-item:hover .recent-arrow {
  opacity: 1;
}
</style>
