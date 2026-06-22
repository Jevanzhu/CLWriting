<script setup lang="ts">
import { ref, onMounted } from 'vue'

interface Book {
  id: string
  name: string
  genre?: string
  kind?: string
  host?: string
}

const books = ref<Book[]>([])
const loading = ref(true)
const error = ref('')

async function loadBooks(): Promise<void> {
  loading.value = true
  error.value = ''
  try {
    const r = await fetch('/api/books')
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
    const data = (await r.json()) as { books: Book[] }
    books.value = data.books ?? []
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    loading.value = false
  }
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
    <div v-else-if="books.length === 0" class="empty">
      <p class="hint">暂无书籍</p>
      <p class="sub">
        1.5 起支持在 GUI 建书；现可用 <code>clwriting init</code> 建书后刷新
      </p>
    </div>
    <ul v-else class="book-list">
      <li v-for="b in books" :key="b.id" class="book-card">
        <div class="book-name">{{ b.name }}</div>
        <div class="book-meta">
          {{ b.genre ?? '—' }} · {{ b.kind ?? '—' }} · {{ b.host ?? '—' }}
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
