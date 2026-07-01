<script setup lang="ts">
// 启动页（landing）：品牌欢迎 + 最近书库/书 + 入口动作。对齐 mockup v5 renderLanding。
// 桌面版注入 window.clwritingDesktop（书库 IPC）；浏览器版隐藏桌面入口。
import { ref, computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { listBooks } from '../api/books'
import type { BookMeta } from '../types'
import VaultMask from '../components/VaultMask.vue'
import { useHint } from '../composables/useHint'

const router = useRouter()
const { hint } = useHint()
const desktop = window.clwritingDesktop ?? null
const isDesktop = computed(() => desktop !== null)
const recentBooks = ref<BookMeta[]>([])
const recentLibs = ref<{ path: string; label: string }[]>([])

async function loadRecent(): Promise<void> {
  try {
    const r = await listBooks()
    recentBooks.value = (r.books ?? []).slice(0, 6)
  } catch {
    /* 空书架时 recentBooks 为空，仍显示欢迎 */
  }
}
async function loadDesktop(): Promise<void> {
  if (!desktop) return
  try {
    recentLibs.value = await desktop.getRecentLibraries()
  } catch {
    /* preload 失败静默 */
  }
}

function fmtDate(iso?: string): string {
  if (!iso) return '—'
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleDateString('zh-CN')
}
function openBook(name: string): void {
  router.push(`/books/${encodeURIComponent(name)}`)
}
function goShelf(): void {
  router.push('/shelf')
}
function goLibraries(): void {
  router.push('/libraries')
}
function newBook(): void {
  router.push('/books/new')
}
const vaultShow = ref(false)
function newLibrary(): void {
  vaultShow.value = true
}
async function openLibrary(): Promise<void> {
  if (desktop) await desktop.openLibrary()
}
async function switchLib(path: string): Promise<void> {
  if (desktop) await desktop.switchLibrary(path)
}

onMounted(() => {
  loadRecent()
  loadDesktop()
  hint('选择书库开始写作 · ⌘P 命令面板 · ⌘⇧F 专注模式')
})
</script>

<template>
  <div class="workspace full">
    <section class="landing">
      <div class="landing-logo">墨</div>
      <div class="landing-title">CLWriting Studio</div>
      <div class="landing-sub">沉浸式写作空间</div>

      <div v-if="recentBooks.length || recentLibs.length" class="landing-recent">
        <template v-if="recentLibs.length">
          <div class="landing-recent-title">最近打开的书库</div>
          <div
            v-for="r in recentLibs"
            :key="'lib-' + r.path"
            class="landing-card lib-card"
            tabindex="0"
            @click="switchLib(r.path)"
            @keydown.enter="switchLib(r.path)"
          >
            <div class="lc-icon long">书</div>
            <div class="lc-info">
              <div class="lc-name">{{ r.label }}</div>
              <div class="lc-meta">{{ r.path }}</div>
            </div>
            <div class="lc-badge">书库</div>
          </div>
        </template>

        <div
          v-if="recentBooks.length"
          class="landing-recent-title"
          :style="recentLibs.length ? 'margin-top:18px' : ''"
        >最近打开的书</div>
        <div
          v-for="b in recentBooks"
          :key="'bk-' + b.name"
          class="landing-card"
          tabindex="0"
          @click="openBook(b.name)"
          @keydown.enter="openBook(b.name)"
        >
          <div class="lc-icon" :class="b.kind">{{ b.kind === 'short' ? '短' : '长' }}</div>
          <div class="lc-info">
            <div class="lc-name">{{ b.name }}</div>
            <div class="lc-meta">{{ b.kind === 'short' ? '短篇集' : '长篇' }} · 创建于 {{ fmtDate(b.created_at) }}</div>
          </div>
          <div class="lc-badge">书</div>
        </div>
      </div>

      <div class="landing-actions">
        <button class="btn primary" @click="goShelf">📚 书架</button>
        <button class="btn" @click="newBook">+ 新建</button>
        <button v-if="isDesktop" class="btn" @click="newLibrary">＋ 新建书库</button>
        <button v-if="isDesktop" class="btn" @click="goLibraries">📚 书库管理</button>
        <button v-if="isDesktop" class="btn" @click="openLibrary">📂 打开书库</button>
      </div>
    </section>
    <VaultMask v-model:show="vaultShow" />
  </div>
</template>
