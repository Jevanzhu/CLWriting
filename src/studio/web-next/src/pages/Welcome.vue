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
    <!-- 环境背景：多层渐变 + 呼吸光晕（签名氛围层） -->
    <div class="ambient">
      <div class="glow glow-tr"></div>
      <div class="glow glow-bl"></div>
    </div>

    <header class="welcome-titlebar" />

    <main class="welcome-stage">
      <!-- 品牌 -->
      <div class="brand">
        <div class="brand-mark"><BookOpen :size="32" /></div>
        <h1 class="brand-name">CLWriting</h1>
        <p class="brand-tagline">选择一个书库目录，开启你的长篇创作之旅</p>
      </div>

      <!-- 入口 -->
      <div v-if="!hasDesktop && !loading" class="entries">
        <p class="no-desktop">书库管理仅在桌面版可用。请使用 CLWriting 桌面应用启动。</p>
      </div>

      <div v-else class="entries">
        <button class="entry primary" @click="chooseLibrary">
          <div class="entry-icon"><Sparkles :size="22" /></div>
          <div class="entry-text">
            <span class="entry-title">新建书库</span>
            <span class="entry-desc">选择一个空目录，建立全新的创作空间</span>
          </div>
          <ArrowRight :size="18" class="entry-arrow" />
        </button>

        <button class="entry" @click="chooseLibrary">
          <div class="entry-icon"><FolderOpen :size="22" /></div>
          <div class="entry-text">
            <span class="entry-title">打开已有书库</span>
            <span class="entry-desc">选择一个包含 .clwriting 的目录继续创作</span>
          </div>
          <ArrowRight :size="18" class="entry-arrow" />
        </button>
      </div>

      <!-- 最近 -->
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

/* ══ 环境氛围层（呼吸光晕，让画面有生命感）══ */
.ambient {
  position: absolute;
  inset: 0;
  pointer-events: none;
  overflow: hidden;
}
.glow {
  position: absolute;
  border-radius: 50%;
  filter: blur(72px);
  will-change: opacity, transform;
}
.glow-tr {
  top: -18%;
  right: -8%;
  width: 58vw;
  height: 58vh;
  background: radial-gradient(circle,
    color-mix(in srgb, var(--interactive-accent) 16%, transparent), transparent 68%);
  animation: breathe 18s var(--ease-std) infinite;
}
.glow-bl {
  bottom: -22%;
  left: -12%;
  width: 48vw;
  height: 48vh;
  background: radial-gradient(circle,
    color-mix(in srgb, var(--interactive-accent) 9%, transparent), transparent 68%);
  animation: breathe 24s var(--ease-std) infinite reverse;
}
@keyframes breathe {
  0%, 100% { opacity: 0.55; transform: scale(1); }
  50%      { opacity: 1; transform: scale(1.1); }
}

/* titlebar drag 区 */
.welcome-titlebar {
  position: relative;
  z-index: 1;
  height: var(--size-tabbar);
  flex-shrink: 0;
}
.welcome.has-traffic .welcome-titlebar {
  -webkit-app-region: drag;
}

/* ══ 舞台 ══ */
.welcome-stage {
  position: relative;
  z-index: 1;
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--size-4-10);
  padding: var(--size-4-6) var(--size-4-6) calc(var(--size-4-12) * 2);
  max-width: 720px;
  margin: 0 auto;
  width: 100%;
}

/* ══ 品牌区 ══ */
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
  width: 80px;
  height: 80px;
  border-radius: var(--radius-l);
  background: color-mix(in srgb, var(--interactive-accent) 14%, transparent);
  color: var(--text-accent);
  box-shadow:
    0 0 0 1px color-mix(in srgb, var(--interactive-accent) 22%, transparent),
    var(--shadow-m),
    0 0 48px color-mix(in srgb, var(--interactive-accent) 20%, transparent);
  animation: mark-in 0.6s var(--ease-out) both;
}
@keyframes mark-in {
  from { opacity: 0; transform: scale(0.82); }
  to   { opacity: 1; transform: scale(1); }
}
.brand-name {
  margin: 0;
  font-size: 48px;
  font-weight: 800;
  letter-spacing: -0.04em;
  line-height: 1;
  /* 渐变文字：accent → normal，门面签名 */
  background: linear-gradient(135deg, var(--text-accent), var(--text-normal) 75%);
  -webkit-background-clip: text;
  background-clip: text;
  -webkit-text-fill-color: transparent;
  color: transparent;
  animation: fade-up 0.5s var(--ease-out) 80ms both;
}
.brand-tagline {
  margin: 0;
  font-size: var(--font-size-l);
  color: var(--text-muted);
  text-align: center;
  animation: fade-up 0.5s var(--ease-out) 140ms both;
}

/* ══ 入口 ══ */
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
  border-radius: var(--radius-l);
  background: color-mix(in srgb, var(--background-primary) 60%, transparent);
  backdrop-filter: blur(6px);
}
.entry {
  display: flex;
  align-items: center;
  gap: var(--size-4-4);
  width: 100%;
  padding: var(--size-4-5) var(--size-4-6);
  border-radius: var(--radius-l);
  cursor: pointer;
  text-align: left;
  transition:
    transform var(--dur-fast) var(--ease-out),
    box-shadow var(--dur-fast) var(--ease-out),
    border-color var(--dur-fast) var(--ease-out);
}
/* 主入口：签名渐变（与总览/开书 Hero 同源） */
.entry.primary {
  border: 1px solid transparent;
  background:
    radial-gradient(ellipse 90% 120% at 100% 0%,
      color-mix(in srgb, var(--interactive-accent-hover) 34%, transparent), transparent 60%),
    linear-gradient(135deg, var(--interactive-accent), var(--interactive-accent-hover));
  color: var(--text-on-accent);
  box-shadow:
    var(--shadow-m),
    0 0 0 1px color-mix(in srgb, var(--interactive-accent) 26%, transparent);
  animation: fade-up 0.5s var(--ease-out) 200ms both;
}
/* 次入口：玻璃质感，透出环境光 */
.entry:not(.primary) {
  border: 1px solid var(--background-modifier-border);
  background: color-mix(in srgb, var(--background-primary) 72%, transparent);
  backdrop-filter: blur(10px);
  color: var(--text-normal);
  animation: fade-up 0.5s var(--ease-out) 260ms both;
}
.entry.primary:hover {
  transform: translateY(-2px);
  box-shadow:
    var(--shadow-l),
    0 0 32px color-mix(in srgb, var(--interactive-accent) 30%, transparent);
}
.entry:not(.primary):hover {
  transform: translateY(-2px);
  border-color: color-mix(in srgb, var(--interactive-accent) 38%, transparent);
  box-shadow: var(--shadow-l);
}

.entry-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 44px;
  height: 44px;
  flex-shrink: 0;
  border-radius: var(--radius-m);
}
.entry.primary .entry-icon {
  background: color-mix(in srgb, var(--text-on-accent) 16%, transparent);
  color: var(--text-on-accent);
}
.entry:not(.primary) .entry-icon {
  background: color-mix(in srgb, var(--interactive-accent) 12%, transparent);
  color: var(--text-accent);
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
}
.entry.primary .entry-title {
  font-weight: 700;
}
.entry-desc {
  font-size: var(--font-size-s);
  color: var(--text-faint);
}
.entry.primary .entry-desc {
  color: color-mix(in srgb, var(--text-on-accent) 72%, transparent);
}
.entry-arrow {
  flex-shrink: 0;
  opacity: 0;
  transform: translateX(-4px);
  transition: opacity var(--dur-fast) var(--ease-out), transform var(--dur-fast) var(--ease-out);
}
.entry:hover .entry-arrow {
  opacity: 1;
  transform: translateX(0);
}

/* ══ 最近列表（书脊意象：左 3px 竖条 hover 亮起）══ */
.recent {
  width: 100%;
  max-width: 480px;
  display: flex;
  flex-direction: column;
  gap: var(--size-4-2);
  animation: fade-up 0.5s var(--ease-out) 320ms both;
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
  padding: var(--size-4-3);
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

/* ══ 入场动画 ══ */
@keyframes fade-up {
  from { opacity: 0; transform: translateY(8px); }
  to   { opacity: 1; transform: none; }
}

/* 窄屏 */
@media (max-width: 520px) {
  .brand-name { font-size: 38px; }
  .brand-mark { width: 68px; height: 68px; }
}
</style>
