<script setup lang="ts">
import { ref, onMounted } from 'vue'
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

function open(name: string): void {
  router.push(`/books/${encodeURIComponent(name)}`)
}

function fmtDate(iso?: string): string {
  if (!iso) return '—'
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString('zh-CN')
}

onMounted(loadBooks)
</script>

<template>
  <section class="bookshelf">
    <div class="bookshelf-head">
      <h2>书架</h2>
      <button class="btn-new" disabled title="1.5 起支持建书">+ 新建</button>
    </div>

    <p v-if="loading" class="hint">加载中…</p>
    <p v-else-if="error" class="hint error">加载失败：{{ error }}</p>
    <div v-else-if="!workDir" class="empty">
      <p class="hint">未定位到工作目录</p>
      <p class="sub">{{ hint || '请在 CLWriting 工作目录（含 .clwriting/）下启动 studio。' }}</p>
    </div>
    <div v-else-if="books.length === 0" class="empty">
      <p class="hint">暂无书籍</p>
      <p class="sub">
        1.5 起支持在 GUI 建书；现可用 <code>clwriting init</code> 建书后刷新
      </p>
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
}
.bookshelf-head h2 {
  margin: 0;
  font-size: 16px;
}
.btn-new {
  padding: 6px 14px;
  border: none;
  border-radius: 6px;
  background: #3b82f6;
  color: #fff;
  cursor: not-allowed;
  opacity: 0.5;
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
.empty code {
  background: #e5e7eb;
  padding: 1px 5px;
  border-radius: 3px;
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
