<script setup lang="ts">
import { ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'

interface BookIdentity {
  name: string
  kind: 'long' | 'short'
  path: string
  created_at?: string
  title: string
  genre: string
}

const route = useRoute()
const router = useRouter()
const book = ref<BookIdentity | null>(null)
const loading = ref(true)
const error = ref('')

async function load(name: string): Promise<void> {
  loading.value = true
  error.value = ''
  book.value = null
  try {
    const r = await fetch(`/api/books/${encodeURIComponent(name)}`)
    if (!r.ok) {
      const e = (await r.json().catch(() => ({}))) as { error?: string }
      throw new Error(e.error ?? `HTTP ${r.status}`)
    }
    book.value = (await r.json()) as BookIdentity
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    loading.value = false
  }
}

// :name 变化（如书架→单书、或直接访问 URL）时重新加载
watch(
  () => route.params.name,
  (n) => {
    if (typeof n === 'string') load(n)
  },
  { immediate: true },
)

function fmtDate(iso?: string): string {
  if (!iso) return '—'
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString('zh-CN')
}
</script>

<template>
  <section class="book-detail">
    <div class="detail-head">
      <button class="btn-back" @click="router.push('/')">← 返回书架</button>
    </div>

    <p v-if="loading" class="hint">加载中…</p>
    <p v-else-if="error" class="hint error">加载失败：{{ error }}</p>
    <article v-else-if="book" class="identity-card">
      <h2 class="title">{{ book.title }}</h2>
      <dl class="meta">
        <div><dt>题材</dt><dd>{{ book.genre || '—' }}</dd></div>
        <div><dt>类型</dt><dd>{{ book.kind === 'short' ? '短篇集' : '长篇' }}</dd></div>
        <div><dt>宿主</dt><dd>未设置（默认 cc）</dd></div>
        <div><dt>创建于</dt><dd>{{ fmtDate(book.created_at) }}</dd></div>
        <div><dt>目录</dt><dd class="mono">{{ book.path }}</dd></div>
      </dl>
      <div class="placeholder">
        <p class="hint">工作台 / 统计台 / 设定台将在 1.3+ 陆续上线。</p>
      </div>
    </article>
  </section>
</template>

<style scoped>
.book-detail {
  max-width: 960px;
  margin: 0 auto;
}
.detail-head {
  margin-bottom: 16px;
}
.btn-back {
  padding: 6px 14px;
  border: 1px solid #d1d5db;
  border-radius: 6px;
  background: #fff;
  cursor: pointer;
  font-size: 14px;
}
.btn-back:hover {
  border-color: #3b82f6;
}
.identity-card {
  background: #fff;
  border: 1px solid #e5e7eb;
  border-radius: 8px;
  padding: 24px;
}
.title {
  margin: 0 0 20px;
  font-size: 20px;
}
.meta {
  margin: 0 0 20px;
  display: grid;
  gap: 10px;
}
.meta > div {
  display: grid;
  grid-template-columns: 80px 1fr;
  align-items: baseline;
}
.meta dt {
  color: #6b7280;
  font-size: 13px;
}
.meta dd {
  margin: 0;
}
.meta .mono {
  font-family: ui-monospace, monospace;
  font-size: 13px;
  color: #4b5563;
}
.placeholder {
  border-top: 1px dashed #e5e7eb;
  padding-top: 16px;
}
.hint {
  color: #6b7280;
}
.hint.error {
  color: #dc2626;
}
</style>
