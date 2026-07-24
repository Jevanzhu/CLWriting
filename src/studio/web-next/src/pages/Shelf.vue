<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { Sun, Moon } from 'lucide-vue-next'
import { useShelfStore } from '../stores/shelf'
import { useTheme } from '../composables/useTheme'
import { apiJson } from '../api/client'

// 书架视图：书列表 + 开书 + 新建书表单 + workDir 缺失引导。
// 书架为全屏页（无外壳），自带主题切换（工作区则走 ribbon）。
const router = useRouter()
const shelf = useShelfStore()
const { theme, toggle } = useTheme()
onMounted(() => shelf.load())

const showCreate = ref(false)
const newName = ref('')
const creating = ref(false)
const createError = ref<string | null>(null)

async function createBook(): Promise<void> {
  const name = newName.value.trim()
  if (!name) return
  creating.value = true
  createError.value = null
  try {
    await apiJson('/api/books', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name }),
    })
    showCreate.value = false
    newName.value = ''
    await shelf.load()
    router.push(`/book/${encodeURIComponent(name)}`)
  } catch (e) {
    createError.value = e instanceof Error ? e.message : String(e)
  } finally {
    creating.value = false
  }
}

function openBook(name: string): void {
  router.push(`/book/${encodeURIComponent(name)}`)
}
</script>

<template>
  <div class="shelf">
    <header class="shelf-head">
      <h1>书架</h1>
      <div class="shelf-actions">
        <button
          class="btn icon"
          :title="theme === 'dark' ? '切到亮色' : '切到暗色'"
          @click="toggle()"
        >
          <Moon v-if="theme === 'light'" :size="16" />
          <Sun v-else :size="16" />
        </button>
        <button class="btn primary" @click="showCreate = true">+ 新建书</button>
      </div>
    </header>

    <div v-if="shelf.loading" class="shelf-status">加载中…</div>
    <div v-else-if="shelf.error" class="shelf-status err">{{ shelf.error }}</div>
    <div v-else-if="shelf.workDirMissing" class="shelf-status">
      <p>未打开书库。</p>
      <p class="sub">{{ shelf.hint ?? '请用 clwriting studio --dir &lt;书库目录&gt; 指定书库。' }}</p>
    </div>
    <div v-else-if="!shelf.books.length" class="shelf-status">
      <p>书库为空。</p>
      <p class="sub">点「新建书」开始第一本。</p>
    </div>
    <div v-else class="book-grid">
      <button v-for="b in shelf.books" :key="b.name" class="book-card" @click="openBook(b.name)">
        <div class="book-title">{{ b.title ?? b.name }}</div>
        <div class="book-name">{{ b.kind ?? '·' }}　{{ b.name }}</div>
      </button>
    </div>

    <div v-if="showCreate" class="modal-overlay" @click.self="showCreate = false">
      <div class="modal">
        <h2>新建书</h2>
        <input
          v-model="newName"
          class="input"
          placeholder="书名（用作目录名）"
          @keyup.enter="createBook"
        />
        <div v-if="createError" class="err">{{ createError }}</div>
        <div class="modal-actions">
          <button class="btn" @click="showCreate = false">取消</button>
          <button class="btn primary" :disabled="creating || !newName.trim()" @click="createBook">
            {{ creating ? '创建中…' : '创建' }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.shelf {
  max-width: 880px;
  margin: 0 auto;
  padding: var(--size-4-6) var(--size-4-4);
}
.shelf-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: var(--size-4-4);
}
.shelf-head h1 {
  margin: 0;
  font-size: 20px;
  font-weight: 600;
}
.shelf-actions {
  display: flex;
  align-items: center;
  gap: var(--size-4-2);
}
.btn {
  padding: 6px 14px;
  border: 1px solid var(--background-modifier-border);
  border-radius: var(--radius-s);
  background: var(--interactive-normal);
  color: var(--text-normal);
  font-size: 13px;
  cursor: pointer;
}
.btn.icon {
  padding: 6px;
  display: flex;
  align-items: center;
  justify-content: center;
}
.btn:hover:not(:disabled) {
  background: var(--interactive-hover);
}
.btn:disabled {
  opacity: 0.5;
  cursor: default;
}
.btn.primary {
  background: var(--interactive-accent);
  border-color: var(--interactive-accent);
  color: var(--text-on-accent);
}
.btn.primary:hover:not(:disabled) {
  background: var(--interactive-accent-hover);
}
.shelf-status {
  padding: var(--size-4-6) 0;
  text-align: center;
  color: var(--text-muted);
}
.shelf-status.err {
  color: var(--text-error);
}
.sub {
  margin-top: var(--size-4-2);
  font-size: 12px;
  color: var(--text-faint);
}
.book-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(160px, 1fr));
  gap: var(--size-4-3);
}
.book-card {
  text-align: left;
  padding: var(--size-4-3);
  border: 1px solid var(--background-modifier-border);
  border-radius: var(--radius-m);
  background: var(--background-secondary);
  color: var(--text-normal);
  cursor: pointer;
  min-height: 90px;
}
.book-card:hover {
  background: var(--background-modifier-hover);
  border-color: var(--background-modifier-border-hover);
}
.book-title {
  font-size: 15px;
  font-weight: 600;
  margin-bottom: var(--size-4-2);
}
.book-name {
  font-size: 12px;
  color: var(--text-faint);
}
.modal-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.4);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 100;
}
.modal {
  background: var(--background-primary);
  border: 1px solid var(--background-modifier-border);
  border-radius: var(--radius-l);
  padding: var(--size-4-4);
  width: 360px;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.2);
}
.modal h2 {
  margin: 0 0 var(--size-4-3);
  font-size: 16px;
}
.input {
  width: 100%;
  padding: 8px var(--size-4-2);
  border: 1px solid var(--background-modifier-border);
  border-radius: var(--radius-s);
  background: var(--background-primary);
  color: var(--text-normal);
  font-size: 14px;
  box-sizing: border-box;
}
.input:focus {
  outline: none;
  border-color: var(--interactive-accent);
}
.modal-actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--size-4-2);
  margin-top: var(--size-4-3);
}
.err {
  color: var(--text-error);
  font-size: 12px;
  margin-top: var(--size-4-2);
}
</style>
