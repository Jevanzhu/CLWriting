<script setup lang="ts">
// 书架（shelf）：统计 bento + 长篇/短篇分区 book-card。对齐 mockup v5 renderShelf。
// 数据维度：BookMeta 仅 name/kind/created_at（无字数/章数/进度/状态点）→
// 省略 mockup 的字数柱状(bc-bars)/进度条(progress)/状态点(dot)/"进行中"卡（不造假数据）。
import { ref, computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { storeToRefs } from 'pinia'
import { useShelfStore } from '../stores/shelf'

const router = useRouter()
const shelf = useShelfStore()
const { books, workDir, hint, loading, error } = storeToRefs(shelf)

const desktop = window.clwritingDesktop ?? null
const isDesktop = computed(() => desktop !== null)
const currentLib = ref<string | null>(null)

const libName = computed(() => {
  if (!currentLib.value) return ''
  const seg = currentLib.value.split(/[/\\]/).filter(Boolean)
  return seg[seg.length - 1] ?? currentLib.value
})
const libraryLabel = computed(() => currentLib.value || '')
const longBooks = computed(() => books.value.filter((b) => b.kind !== 'short'))
const shortBooks = computed(() => books.value.filter((b) => b.kind === 'short'))

async function loadDesktop(): Promise<void> {
  if (!desktop) return
  try {
    currentLib.value = await desktop.getCurrentLibrary()
  } catch {
    /* preload 失败静默 */
  }
}
async function openLibrary(): Promise<void> {
  if (desktop) await desktop.openLibrary()
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
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleDateString('zh-CN')
}

onMounted(() => {
  shelf.loadBooks()
  loadDesktop()
})
</script>

<template>
  <div class="workspace full">
    <div class="shelf-inner">
      <div class="shelf-head">
        <div class="logo">墨</div>
        <div>
          <div class="shelf-title">书架</div>
          <div v-if="libName" style="color:var(--text-3);font-size:11px;letter-spacing:.5px;margin-top:2px">· {{ libName }}</div>
        </div>
        <div class="shelf-sub" :title="libraryLabel">{{ libraryLabel || 'CLWriting 工作目录' }}</div>
        <button v-if="isDesktop" class="btn" @click="openLibrary">📂 打开书库</button>
        <button class="btn primary" @click="newBook">+ 新建书</button>
      </div>

      <p v-if="loading" class="bc-foot" style="margin:24px 0">加载中…</p>
      <p v-else-if="error" style="margin:24px 0;color:var(--cinnabar);font-size:13px">加载失败：{{ error }}</p>
      <div v-else-if="!workDir" style="text-align:center;padding:60px 0">
        <p style="color:var(--text-2)">未定位到工作目录</p>
        <p v-if="isDesktop" style="margin-top:12px"><button class="btn primary" @click="openLibrary">📁 选择书库目录</button></p>
        <p v-else style="color:var(--text-3);font-size:13px;margin-top:8px">{{ hint || '请在 CLWriting 工作目录（含 .clwriting/）下启动 studio。' }}</p>
      </div>
      <div v-else-if="!books.length" style="text-align:center;padding:60px 0">
        <p style="color:var(--text-2)">暂无书籍</p>
        <p style="color:var(--text-3);font-size:13px;margin-top:8px">点右上「+ 新建书」建第一本书</p>
      </div>

      <template v-else>
        <!-- 统计 bento（真实无字数：主卡放书籍总览，省柱状/进行中） -->
        <div class="bento-grid" style="margin:18px 0 24px">
          <div class="bento-card bento-lg">
            <div class="bc-menu">⋮</div>
            <div class="bc-label">书籍总览</div>
            <div class="bc-stat">{{ books.length }}<span> 本</span></div>
            <div class="bc-foot">{{ longBooks.length }} 长篇 · {{ shortBooks.length }} 短篇集</div>
          </div>
          <div class="bento-card"><div class="bc-menu">⋮</div><div class="bc-label">总书数</div><div class="bc-stat">{{ books.length }}</div></div>
          <div class="bento-card"><div class="bc-menu">⋮</div><div class="bc-label">长篇</div><div class="bc-stat">{{ longBooks.length }}</div></div>
          <div class="bento-card"><div class="bc-menu">⋮</div><div class="bc-label">短篇集</div><div class="bc-stat">{{ shortBooks.length }}</div></div>
        </div>

        <div class="shelf-sections">
          <div class="shelf-section">
            <div class="shelf-section-title">📖 长篇 <span class="cnt">{{ longBooks.length }} 本</span></div>
            <div class="book-grid">
              <div
                v-for="b in longBooks"
                :key="b.name"
                class="book-card"
                tabindex="0"
                @click="open(b.name)"
                @keydown.enter="open(b.name)"
              >
                <div class="bc-top"><span class="bc-name">{{ b.name }}</span></div>
                <div class="bc-meta">长篇 · 创建于 {{ fmtDate(b.created_at) }}</div>
              </div>
              <div class="shelf-new-card" tabindex="0" @click="newBook" @keydown.enter="newBook">
                <span class="plus">＋</span><span>新建长篇</span>
              </div>
            </div>
          </div>

          <div class="shelf-section">
            <div class="shelf-section-title">📝 短篇集 <span class="cnt">{{ shortBooks.length }} 本</span></div>
            <div class="book-grid">
              <div
                v-for="b in shortBooks"
                :key="b.name"
                class="book-card"
                tabindex="0"
                @click="open(b.name)"
                @keydown.enter="open(b.name)"
              >
                <div class="bc-top"><span class="bc-name">{{ b.name }}</span></div>
                <div class="bc-meta">短篇集 · 创建于 {{ fmtDate(b.created_at) }}</div>
              </div>
              <div class="shelf-new-card" tabindex="0" @click="newBook" @keydown.enter="newBook">
                <span class="plus">＋</span><span>新建短篇集</span>
              </div>
            </div>
          </div>
        </div>
      </template>
    </div>
  </div>
</template>
