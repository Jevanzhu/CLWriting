<script setup lang="ts">
// 书库管理（libraries）：当前书库 + 最近书库列表 + 切换（relaunch）/ 打开选择器。
// 对齐 mockup renderLibraries，但真实为单 workDir 架构（一次一书库，切换=app.relaunch）。
// mockup 的"重命名/删除书库"无后端支持（workdir-store 只存路径）→ 省略。
import { ref, computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'

const router = useRouter()
const desktop = window.clwritingDesktop ?? null
const isDesktop = computed(() => desktop !== null)
const recentLibs = ref<{ path: string; label: string }[]>([])
const currentLib = ref<string | null>(null)

const currentLabel = computed(() => {
  if (!currentLib.value) return ''
  const seg = currentLib.value.split(/[/\\]/).filter(Boolean)
  return seg[seg.length - 1] ?? currentLib.value
})

async function load(): Promise<void> {
  if (!desktop) return
  try {
    const [recent, current] = await Promise.all([
      desktop.getRecentLibraries(),
      desktop.getCurrentLibrary(),
    ])
    recentLibs.value = recent
    currentLib.value = current
  } catch {
    /* preload 失败静默 */
  }
}

/** 切到最近书库（主进程 relaunch 重启到新目录） */
async function switchTo(path: string): Promise<void> {
  if (desktop) await desktop.switchLibrary(path)
}
/** 打开书库选择器（主进程弹原生目录选择 → relaunch） */
async function openLibrary(): Promise<void> {
  if (desktop) await desktop.openLibrary()
}
function goShelf(): void {
  router.push('/shelf')
}

onMounted(load)
</script>

<template>
  <section class="libs">
    <div class="bento-wrap" style="max-width:760px">
      <div class="bento-head">
        <h1 class="bento-title">书库</h1>
        <div class="bento-sub">
          <span class="meta-chip">{{ recentLibs.length }} 个最近</span>
          <span v-if="currentLabel" class="meta-chip">{{ currentLabel }}</span>
        </div>
      </div>

      <p v-if="!isDesktop" class="hint">书库管理为桌面端功能（浏览器版单工作目录）。桌面版可切换 / 打开书库目录。</p>
      <template v-else>
        <!-- 当前书库 -->
        <div v-if="currentLib" class="bento-card lib-current">
          <div class="bc-label">当前书库</div>
          <div class="lib-name">{{ currentLabel }}</div>
          <div class="lib-path">{{ currentLib }}</div>
          <div class="bc-btns">
            <button class="neo-btn" @click="goShelf">📚 打开书架</button>
            <button class="neo-btn" @click="openLibrary">📂 切换书库</button>
          </div>
        </div>

        <!-- 最近书库 -->
        <div v-if="recentLibs.length" class="bento-card">
          <div class="bc-label">最近书库</div>
          <div class="bc-list">
            <div
              v-for="r in recentLibs"
              :key="r.path"
              class="bc-list-row"
              :class="{ active: r.path === currentLib }"
              :title="r.path"
              tabindex="0"
              @click="switchTo(r.path)"
              @keydown.enter="switchTo(r.path)"
            >
              <span>{{ r.label }}</span>
              <span class="lr-sub">{{ r.path === currentLib ? '当前' : '切换 →' }}</span>
            </div>
          </div>
        </div>

        <div class="bc-btns" style="margin-top:16px">
          <button class="neo-btn" @click="openLibrary">+ 新建 / 打开其他书库</button>
        </div>
      </template>
    </div>
  </section>
</template>

<style scoped>
.libs{margin:0 auto}
.lib-current{margin-bottom:16px}
.lib-name{font-size:18px;font-weight:700;color:var(--ink);margin:6px 0 4px}
.lib-path{font-size:11px;color:var(--text-3);font-family:ui-monospace,monospace;word-break:break-all;line-height:1.5}
.bc-list-row.active{color:var(--ink-cyan);font-weight:600}
.libs .hint{color:var(--text-2);font-size:13px;padding:24px 0}
</style>
