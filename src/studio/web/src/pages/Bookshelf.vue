<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'

interface BookEntry {
  name: string
  path: string
  kind: 'long' | 'short'
  created_at?: string
}

const router = useRouter()
const books = ref<BookEntry[]>([])
const workDir = ref(true)
const hint = ref('')
const loading = ref(true)
const error = ref('')

// 桌面版书库管理（preload 注入；浏览器版不存在 → isDesktop=false，隐藏桌面入口）
const desktop = window.clwritingDesktop ?? null
const isDesktop = computed(() => desktop !== null)
const recentLibs = ref<{ path: string; label: string }[]>([])
const currentLib = ref<string | null>(null)
const currentLibLabel = computed(() => {
  if (!currentLib.value) return ''
  const seg = currentLib.value.split(/[/\\]/).filter(Boolean)
  return seg[seg.length - 1] ?? currentLib.value
})

async function loadBooks(): Promise<void> {
  loading.value = true
  error.value = ''
  try {
    const r = await fetch('/api/books')
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
    const data = (await r.json()) as {
      books: BookEntry[]
      workDir: boolean
      hint?: string
    }
    books.value = data.books ?? []
    workDir.value = data.workDir
    hint.value = data.hint ?? ''
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    loading.value = false
  }
}

/** 拉桌面版当前书库 + 最近列表（浏览器版空操作）。 */
async function loadDesktop(): Promise<void> {
  if (!desktop) return
  try {
    const [recent, current] = await Promise.all([
      desktop.getRecentLibraries(),
      desktop.getCurrentLibrary(),
    ])
    recentLibs.value = recent
    currentLib.value = current
  } catch {
    // preload API 失败静默，不影响书架核心功能
  }
}

/** 打开书库选择器（主进程 relaunch 到新目录；取消无操作）。 */
async function openLibrary(): Promise<void> {
  if (!desktop) return
  await desktop.openLibrary()
}

/** 切换到最近书库（主进程 relaunch）。 */
async function switchTo(path: string): Promise<void> {
  if (!desktop) return
  await desktop.switchLibrary(path)
}

function open(name: string): void {
  router.push(`/books/${encodeURIComponent(name)}`)
}

function newBook(): void {
  router.push('/books/new')
}

function fmtDate(iso?: string): string {
  if (!iso) return '—'
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString('zh-CN')
}

onMounted(() => {
  loadBooks()
  loadDesktop()
})
</script>

<template>
  <section class="bookshelf">
    <div class="bookshelf-head">
      <div class="head-left">
        <h2>书架</h2>
        <span v-if="currentLibLabel" class="current-lib" :title="currentLib ?? ''">{{
          currentLibLabel
        }}</span>
      </div>
      <div class="head-right">
        <button v-if="isDesktop" class="btn-ghost" @click="openLibrary">📁 打开书库</button>
        <details v-if="isDesktop && recentLibs.length" class="recent-dropdown">
          <summary>最近 ▾</summary>
          <ul>
            <li
              v-for="r in recentLibs"
              :key="r.path"
              :title="r.path"
              tabindex="0"
              @click="switchTo(r.path)"
              @keydown.enter="switchTo(r.path)"
            >
              {{ r.label }}
            </li>
          </ul>
        </details>
        <button class="btn-new" @click="newBook">+ 新建</button>
      </div>
    </div>

    <p v-if="loading" class="hint">加载中…</p>
    <p v-else-if="error" class="hint error">加载失败：{{ error }}</p>
    <div v-else-if="!workDir" class="empty">
      <p class="hint">未定位到工作目录</p>
      <p v-if="isDesktop" class="sub">
        <button class="btn-new" @click="openLibrary">📁 选择书库目录</button>
      </p>
      <p v-else class="sub">{{ hint || '请在 CLWriting 工作目录（含 .clwriting/）下启动 studio。' }}</p>
    </div>
    <div v-else-if="books.length === 0" class="empty">
      <p class="hint">暂无书籍</p>
      <p class="sub">点右上「+ 新建」建第一本书</p>
    </div>
    <ul v-else class="book-list">
      <li
        v-for="b in books"
        :key="b.name"
        class="book-card"
        tabindex="0"
        @click="open(b.name)"
        @keydown.enter="open(b.name)"
      >
        <div class="book-name">{{ b.name }}</div>
        <div class="book-meta">
          {{ b.kind === 'short' ? '短篇集' : '长篇' }} · 创建于 {{ fmtDate(b.created_at) }}
        </div>
      </li>
    </ul>
  </section>
</template>

<style scoped>
.bookshelf {
  max-width: 960px;
  margin: 0 auto;
}
.bookshelf-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 16px;
  gap: 8px;
}
.head-left {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}
.bookshelf-head h2 {
  margin: 0;
  font-size: 16px;
}
.current-lib {
  color: #9ca3af;
  font-size: 12px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.head-right {
  display: flex;
  align-items: center;
  gap: 8px;
}
.btn-new {
  padding: 6px 14px;
  border: none;
  border-radius: 6px;
  background: #3b82f6;
  color: #fff;
  cursor: pointer;
}
.btn-new:hover {
  background: #2563eb;
}
.btn-ghost {
  padding: 6px 12px;
  border: 1px solid #d1d5db;
  border-radius: 6px;
  background: #fff;
  color: #374151;
  cursor: pointer;
  font-size: 13px;
}
.btn-ghost:hover {
  border-color: #3b82f6;
  color: #3b82f6;
}
.recent-dropdown {
  position: relative;
}
.recent-dropdown summary {
  cursor: pointer;
  font-size: 13px;
  color: #6b7280;
  padding: 6px 8px;
  border-radius: 6px;
  list-style: none;
}
.recent-dropdown summary:hover {
  background: #f3f4f6;
}
.recent-dropdown ul {
  position: absolute;
  right: 0;
  top: 100%;
  margin: 4px 0 0;
  padding: 4px 0;
  list-style: none;
  background: #fff;
  border: 1px solid #e5e7eb;
  border-radius: 8px;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.08);
  min-width: 160px;
  z-index: 10;
}
.recent-dropdown li {
  padding: 6px 12px;
  cursor: pointer;
  font-size: 13px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 240px;
}
.recent-dropdown li:hover,
.recent-dropdown li:focus-visible {
  background: #eff6ff;
  color: #3b82f6;
  outline: none;
}
.hint {
  color: #6b7280;
}
.hint.error {
  color: #dc2626;
}
.empty {
  text-align: center;
  padding: 48px 0;
}
.empty .sub {
  color: #9ca3af;
  font-size: 13px;
  margin-top: 8px;
}
.book-list {
  list-style: none;
  padding: 0;
  margin: 0;
  display: grid;
  gap: 12px;
}
.book-card {
  background: #fff;
  border: 1px solid #e5e7eb;
  border-radius: 8px;
  padding: 14px 16px;
  cursor: pointer;
  transition: border-color 0.15s, box-shadow 0.15s;
}
.book-card:hover,
.book-card:focus-visible {
  border-color: #3b82f6;
  box-shadow: 0 1px 4px rgba(59, 130, 246, 0.15);
  outline: none;
}
.book-name {
  font-weight: 600;
}
.book-meta {
  color: #6b7280;
  font-size: 13px;
  margin-top: 4px;
}
</style>
