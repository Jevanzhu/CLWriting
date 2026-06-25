<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { storeToRefs } from 'pinia'
import { useShelfStore } from '../stores/shelf'

// 书架数据态走 store（books/workDir/hint/loading/error + loadBooks）
const router = useRouter()
const shelf = useShelfStore()
const { books, workDir, hint, loading, error } = storeToRefs(shelf)

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
const libraryLabel = computed(() => currentLibLabel.value || '当前工作目录')
const longBooks = computed(() => books.value.filter((b) => b.kind !== 'short'))
const shortBooks = computed(() => books.value.filter((b) => b.kind === 'short'))
const bookGroups = computed(() => [
  { key: 'long', title: '长篇', desc: '连续章节创作', empty: '暂无长篇', books: longBooks.value },
  { key: 'short', title: '短篇', desc: '短篇集与单篇创作', empty: '暂无短篇', books: shortBooks.value },
])

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
  shelf.loadBooks()
  loadDesktop()
})
</script>

<template>
  <section class="bookshelf">
    <div class="panel-pad">
      <div class="bookshelf-head">
        <div class="head-left">
          <div class="panel-title">书库</div>
          <div class="panel-sub" style="margin-bottom:0">{{ libraryLabel }}</div>
        </div>
        <div class="head-right">
          <button v-if="isDesktop" class="btn" @click="openLibrary">📁 打开书库</button>
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
              >{{ r.label }}</li>
            </ul>
          </details>
          <button class="btn primary" @click="newBook">+ 新建</button>
        </div>
      </div>

      <p v-if="loading" class="hint">加载中…</p>
      <p v-else-if="error" class="hint error">加载失败：{{ error }}</p>
      <div v-else-if="!workDir" class="empty">
        <p class="hint">未定位到工作目录</p>
        <p v-if="isDesktop" class="sub"><button class="btn primary" @click="openLibrary">📁 选择书库目录</button></p>
        <p v-else class="sub">{{ hint || '请在 CLWriting 工作目录（含 .clwriting/）下启动 studio。' }}</p>
      </div>
      <div v-else-if="books.length === 0" class="empty">
        <p class="hint">暂无书籍</p>
        <p class="sub">点右上「+ 新建」建第一本书</p>
      </div>
      <div v-else class="library-tree">
        <section
          v-for="group in bookGroups"
          :key="group.key"
          class="book-group"
          :aria-labelledby="`group-${group.key}`"
        >
          <div class="group-head">
            <div>
              <h2 :id="`group-${group.key}`">{{ group.title }}</h2>
              <p>{{ group.desc }}</p>
            </div>
            <span class="group-count">{{ group.books.length }}</span>
          </div>
          <div v-if="group.books.length" class="book-grid">
            <div
              v-for="b in group.books"
              :key="b.name"
              class="book-card"
              tabindex="0"
              @click="open(b.name)"
              @keydown.enter="open(b.name)"
            >
              <div class="book-name">{{ b.name }}</div>
              <div class="book-meta">创建于 {{ fmtDate(b.created_at) }}</div>
            </div>
          </div>
          <p v-else class="group-empty">{{ group.empty }}</p>
        </section>
      </div>
    </div>
  </section>
</template>

<style scoped>
.bookshelf {
  margin: 0 auto;
}
.bookshelf-head {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  margin-bottom: 20px;
  gap: 12px;
}
.head-left {
  min-width: 0;
}
.head-right {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}
.recent-dropdown {
  position: relative;
}
.recent-dropdown summary {
  cursor: pointer;
  font-size: 12px;
  color: var(--text-2);
  padding: 6px 10px;
  border: 1px solid var(--border);
  border-radius: 7px;
  list-style: none;
  background: var(--panel);
}
.recent-dropdown summary:hover {
  border-color: var(--ink-cyan);
  color: var(--ink-cyan);
}
.recent-dropdown ul {
  position: absolute;
  right: 0;
  top: 100%;
  margin: 4px 0 0;
  padding: 4px 0;
  list-style: none;
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 8px;
  box-shadow: var(--shadow);
  min-width: 180px;
  z-index: 10;
}
.recent-dropdown li {
  padding: 6px 12px;
  cursor: pointer;
  font-size: 12px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 240px;
}
.recent-dropdown li:hover,
.recent-dropdown li:focus-visible {
  background: var(--active-bg);
  color: var(--ink-cyan);
  outline: none;
}
.library-tree {
  display: grid;
  gap: 22px;
}
.book-group {
  border-top: 1px solid var(--border);
  padding-top: 16px;
}
.group-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 12px;
}
.group-head h2 {
  margin: 0;
  font-size: 15px;
  font-weight: 650;
}
.group-head p {
  margin: 4px 0 0;
  color: var(--text-3);
  font-size: 12px;
}
.group-count {
  min-width: 28px;
  height: 24px;
  padding: 0 8px;
  border: 1px solid var(--border);
  border-radius: 999px;
  color: var(--text-2);
  font-size: 12px;
  line-height: 22px;
  text-align: center;
  background: var(--panel);
}
.book-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
  gap: 12px;
}
.book-card {
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 9px;
  padding: 16px 18px;
  cursor: pointer;
  transition: border-color 0.15s, box-shadow 0.15s;
}
.book-card:hover,
.book-card:focus-visible {
  border-color: var(--ink-cyan);
  box-shadow: var(--shadow);
  outline: none;
}
.book-name {
  font-weight: 600;
  font-size: 14px;
}
.book-meta {
  color: var(--text-2);
  font-size: 12px;
  margin-top: 5px;
}
.group-empty {
  margin: 0;
  color: var(--text-3);
  font-size: 13px;
}
.hint {
  color: var(--text-2);
}
.hint.error {
  color: var(--cinnabar);
}
.empty {
  text-align: center;
  padding: 60px 0;
}
.empty .sub {
  color: var(--text-3);
  font-size: 13px;
  margin-top: 10px;
}
</style>
