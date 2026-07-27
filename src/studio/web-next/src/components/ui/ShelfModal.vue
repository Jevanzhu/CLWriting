<script setup lang="ts">
// 书架浮层（仿设置 modal）：主窗口内 Teleport 浮层，长篇/短篇左右并排。
// 替代独立书架窗口——更轻量、与设置交互统一；选书即关浮层 + 路由跳转。
import { onMounted, onBeforeUnmount, computed, ref } from 'vue'
import { useRouter } from 'vue-router'
import { X, BookOpen, ArrowRight, LayoutGrid, List, Sun, Moon } from 'lucide-vue-next'
import { useShelfStore } from '../../stores/shelf'
import { useUiStore } from '../../stores/ui'
import { useTheme } from '../../composables/useTheme'
import { apiJson } from '../../api/client'

const router = useRouter()
const ui = useUiStore()
const shelf = useShelfStore()
const { theme, toggle } = useTheme()

// 按 kind 分组（长篇/短篇），空组不渲染
const groups = computed(() => {
  const longBks = shelf.books.filter((b) => b.kind !== 'short')
  const shortBks = shelf.books.filter((b) => b.kind === 'short')
  return [
    { title: '长篇', books: longBks },
    { title: '短篇', books: shortBks },
  ].filter((g) => g.books.length)
})

// 最近编辑的书（hero"继续写作"用）
const latestBook = computed(() => {
  const sorted = shelf.books
    .filter((b) => b.lastEdited)
    .sort((a, b) => new Date(b.lastEdited!).getTime() - new Date(a.lastEdited!).getTime())
  return sorted[0] ?? null
})

// 视图模式（网格/列表），localStorage 持久化
const storedView = typeof localStorage !== 'undefined' ? localStorage.getItem('clw-shelf-view') : null
const viewMode = ref<'grid' | 'list'>(storedView === 'list' ? 'list' : 'grid')
function setView(mode: 'grid' | 'list'): void {
  viewMode.value = mode
  try {
    localStorage.setItem('clw-shelf-view', mode)
  } catch {
    /* localStorage 不可用时忽略 */
  }
}

// 新建书
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
    ui.closeShelf()
    router.push(`/book/${encodeURIComponent(name)}`)
  } catch (e) {
    createError.value = e instanceof Error ? e.message : String(e)
  } finally {
    creating.value = false
  }
}

// 选书：记 lastBook + 关浮层 + 路由跳转（主窗口内，无需跨窗口 IPC）
function openBook(name: string): void {
  try {
    localStorage.setItem('clw-last-book', name)
  } catch {
    /* 忽略 */
  }
  ui.closeShelf()
  router.push(`/book/${encodeURIComponent(name)}`)
}

// 字数千分位 + 万字简写
function formatWords(n?: number): string {
  if (!n) return '0 字'
  if (n < 10000) return `${n.toLocaleString()} 字`
  return `${(n / 10000).toFixed(1)} 万字`
}
// 最近编辑相对时间
function formatRelative(iso?: string | null): string {
  if (!iso) return ''
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return ''
  const min = Math.floor((Date.now() - then) / 60000)
  if (min < 1) return '刚刚'
  if (min < 60) return `${min} 分钟前`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr} 小时前`
  const day = Math.floor(hr / 24)
  if (day < 30) return `${day} 天前`
  const month = Math.floor(day / 30)
  if (month < 12) return `${month} 个月前`
  return `${Math.floor(month / 12)} 年前`
}

// 目标字数完成百分比（hero 进度条）
function progressPercent(b: { words?: number; targetWords?: number }): number {
  if (!b.targetWords || !b.words) return 0
  return Math.min(100, Math.round((b.words / b.targetWords) * 100))
}

// Linear 风光晕：鼠标位置写入 --mx/--my 驱动卡片 ::before 的 radial-gradient 圆心
function onCardMove(e: MouseEvent): void {
  const el = e.currentTarget as HTMLElement
  const r = el.getBoundingClientRect()
  el.style.setProperty('--mx', `${e.clientX - r.left}px`)
  el.style.setProperty('--my', `${e.clientY - r.top}px`)
}

// Esc 关闭（mask 点击已支持；键盘可达性补全）
function onKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape') {
    if (showCreate.value) showCreate.value = false
    else if (ui.shelfOpen) ui.closeShelf()
  }
}
onMounted(() => {
  shelf.load()
  window.addEventListener('keydown', onKeydown)
})
onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown))
</script>

<template>
  <Teleport to="body">
    <div v-if="ui.shelfOpen" class="shelf-mask" @click.self="ui.closeShelf">
      <div class="shelf-modal">
        <header class="modal-head">
          <div class="head-left">
            <h2 class="head-title">书架</h2>
            <span v-if="shelf.books.length" class="head-count">{{ shelf.books.length }} 部</span>
          </div>
          <div class="head-actions">
            <div class="view-toggle">
              <button
                class="toggle-btn"
                :class="{ active: viewMode === 'grid' }"
                data-tip="网格视图"
                @click="setView('grid')"
              >
                <LayoutGrid :size="15" />
              </button>
              <button
                class="toggle-btn"
                :class="{ active: viewMode === 'list' }"
                data-tip="列表视图"
                @click="setView('list')"
              >
                <List :size="15" />
              </button>
            </div>
            <button
              class="btn icon"
              :title="theme === 'dark' ? '切到亮色' : '切到暗色'"
              @click="toggle($event)"
            >
              <Moon v-if="theme === 'light'" :size="16" />
              <Sun v-else :size="16" />
            </button>
            <button class="btn primary" @click="showCreate = true">+ 新建书</button>
            <button class="close-btn" title="关闭（Esc）" @click="ui.closeShelf">
              <X :size="18" />
            </button>
          </div>
        </header>

        <div class="modal-body">
          <div v-if="shelf.loading" class="shelf-status">加载中…</div>
          <div v-else-if="shelf.error" class="shelf-status err">{{ shelf.error }}</div>
          <div v-else-if="!shelf.books.length" class="shelf-empty">
            <BookOpen :size="40" class="empty-icon" />
            <p class="empty-title">书库还是空的</p>
            <p class="empty-text">建第一本书，开始你的长篇之旅</p>
            <button class="btn primary" @click="showCreate = true">+ 新建书</button>
          </div>
          <div v-else class="groups-grid">
            <section
              v-if="latestBook && viewMode === 'grid'"
              class="hero-card"
              @mousemove="onCardMove"
              @click="openBook(latestBook.name)"
            >
              <div class="hero-left">
                <span class="hero-label">继续写作</span>
                <ArrowRight :size="15" class="hero-arrow" />
              </div>
              <div class="hero-mid">
                <h3 class="hero-title">{{ latestBook.title ?? latestBook.name }}</h3>
                <p v-if="latestBook.latestChapter" class="hero-recent">最近 · {{ latestBook.latestChapter }}</p>
              </div>
              <div v-if="latestBook.targetWords" class="hero-prog">
                <div class="progress-bar">
                  <div class="progress-fill" :style="{ width: progressPercent(latestBook) + '%' }" />
                </div>
                <span class="progress-text">{{ formatWords(latestBook.words) }} / {{ formatWords(latestBook.targetWords) }}</span>
              </div>
              <div class="hero-foot">
                <span>{{ latestBook.chapters ?? 0 }} {{ latestBook.kind === 'short' ? '篇' : '章' }}</span>
                <span v-if="latestBook.lastEdited" class="hero-time">{{ formatRelative(latestBook.lastEdited) }}</span>
              </div>
            </section>
            <section
              v-else-if="latestBook"
              class="hero-list"
              @mousemove="onCardMove"
              @click="openBook(latestBook.name)"
            >
              <span class="hero-list-label">继续写作</span>
              <span class="hero-list-name">{{ latestBook.title ?? latestBook.name }}</span>
              <span v-if="latestBook.latestChapter" class="hero-list-recent">最近 · {{ latestBook.latestChapter }}</span>
              <span class="hero-list-meta">
                <span>{{ latestBook.chapters ?? 0 }} {{ latestBook.kind === 'short' ? '篇' : '章' }}</span>
                <span v-if="latestBook.lastEdited">{{ formatRelative(latestBook.lastEdited) }}</span>
              </span>
              <ArrowRight :size="15" class="hero-list-arrow" />
            </section>
            <section v-for="grp in groups" :key="grp.title" class="book-section">
              <header class="section-head">
                <h3 class="section-title">{{ grp.title }}</h3>
                <span class="section-count">{{ grp.books.length }} 部</span>
              </header>
              <div v-if="viewMode === 'grid'" class="book-grid">
                <button
                  v-for="b in grp.books"
                  :key="b.name"
                  class="book-card"
                  @mousemove="onCardMove"
                  @click="openBook(b.name)"
                >
                  <h4 class="book-title">{{ b.title ?? b.name }}</h4>
                  <ArrowRight :size="15" class="card-arrow" />
                  <div class="card-foot">
                    <div class="card-stats">
                      <span>{{ b.chapters ?? 0 }} {{ b.kind === 'short' ? '篇' : '章' }}</span>
                      <span v-if="b.kind !== 'short'">{{ formatWords(b.words) }}</span>
                    </div>
                    <span v-if="b.lastEdited" class="book-time">{{ formatRelative(b.lastEdited) }}</span>
                  </div>
                </button>
              </div>
              <div v-else class="book-list">
                <div class="list-head">
                  <span class="col-name">名称</span>
                  <span class="col-num">章节</span>
                  <span class="col-num">字数</span>
                  <span class="col-edited">最近</span>
                </div>
                <button
                  v-for="b in grp.books"
                  :key="b.name"
                  class="list-row"
                  @mousemove="onCardMove"
                  @click="openBook(b.name)"
                >
                  <div class="col-name">
                    <span class="list-name">{{ b.title ?? b.name }}</span>
                    <span v-if="b.latestChapter" class="list-recent">{{ b.latestChapter }}</span>
                  </div>
                  <span class="col-num">{{ b.chapters ?? 0 }} {{ b.kind === 'short' ? '篇' : '章' }}</span>
                  <span class="col-num">{{ b.kind === 'short' ? '—' : formatWords(b.words) }}</span>
                  <span class="col-edited">{{ b.lastEdited ? formatRelative(b.lastEdited) : '—' }}</span>
                  <ArrowRight :size="15" class="list-arrow" />
                </button>
              </div>
            </section>
          </div>
        </div>
      </div>

      <!-- 新建书弹窗（浮层内的浮层，z 更高）-->
      <div v-if="showCreate" class="create-overlay" @click.self="showCreate = false">
        <div class="create-modal">
          <h3>新建书</h3>
          <input
            v-model="newName"
            class="input"
            placeholder="书名（用作目录名）"
            @keyup.enter="createBook"
          />
          <div v-if="createError" class="err">{{ createError }}</div>
          <div class="create-actions">
            <button class="btn" @click="showCreate = false">取消</button>
            <button class="btn primary" :disabled="creating || !newName.trim()" @click="createBook">
              {{ creating ? '创建中…' : '创建' }}
            </button>
          </div>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
/* mask + 居中浮层（对齐设置 SettingsModal 的视觉语言）*/
.shelf-mask {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.35);
  z-index: 150;
  display: flex;
  align-items: flex-start;
  justify-content: center;
  padding-top: 24vh;
  animation: clw-overlay var(--dur-norm) var(--ease-out);
}
.shelf-modal {
  width: min(92vw, 760px);
  max-height: calc(76vh - 24px);
  display: flex;
  flex-direction: column;
  background: var(--background-primary);
  border: 1px solid var(--background-modifier-border);
  border-radius: var(--radius-l);
  box-shadow: var(--shadow-l);
  overflow: hidden;
  animation: clw-appear var(--dur-norm) var(--ease-out);
}
/* 顶部 head：标题 + 计数 / 视图切换 + 主题 + 新建 + 关闭 */
.modal-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--size-4-4);
  padding: var(--size-4-4) var(--size-4-5);
  border-bottom: 1px solid var(--background-modifier-border);
}
.head-left {
  display: flex;
  align-items: baseline;
  gap: var(--size-4-3);
}
.head-title {
  margin: 0;
  font-size: var(--font-size-xl);
  font-weight: 700;
  letter-spacing: -0.02em;
  color: var(--text-normal);
}
.head-count {
  font-size: var(--font-size-s);
  color: var(--text-faint);
  font-variant-numeric: tabular-nums;
}
.head-actions {
  display: flex;
  align-items: center;
  gap: var(--size-4-2);
}
/* 视图切换 segmented control */
.view-toggle {
  display: flex;
  gap: 2px;
  padding: 2px;
  border-radius: var(--radius-s);
  background: var(--background-secondary);
  border: 1px solid var(--background-modifier-border);
}
.toggle-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 4px;
  border: none;
  border-radius: calc(var(--radius-s) - 1px);
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
  transition: background var(--dur-fast) var(--ease-out), color var(--dur-fast) var(--ease-out);
}
.toggle-btn:hover {
  color: var(--text-normal);
}
.toggle-btn.active {
  background: var(--background-primary);
  color: var(--text-normal);
  box-shadow: var(--shadow-s);
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
.close-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border: none;
  background: transparent;
  color: var(--text-faint);
  border-radius: var(--radius-s);
  cursor: pointer;
}
.close-btn:hover {
  color: var(--text-normal);
  background: var(--background-modifier-hover);
}

/* 主体：滚动区 */
.modal-body {
  flex: 1;
  overflow: auto;
  padding: var(--size-4-5);
}
.shelf-status {
  padding: var(--size-4-8) 0;
  text-align: center;
  color: var(--text-muted);
}
.shelf-status.err {
  color: var(--text-error);
}
/* 空态：居中 */
.shelf-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--size-4-2);
  padding: var(--size-4-12) 0;
  color: var(--text-faint);
}
.empty-icon {
  color: var(--text-faint);
}
.empty-title {
  margin: var(--size-4-2) 0 0;
  font-size: var(--font-size-l);
  font-weight: 600;
  color: var(--text-muted);
}
.empty-text {
  margin: 0;
  font-size: 13px;
}

/* 长篇/短篇并排：auto-fit 自适应——两类左右栏，单类时占满整行 */
.groups-grid {
  display: flex;
  flex-direction: column;
  gap: var(--size-4-6);
}
/* hero 跨整宽（grid-column 1/-1）——继续写作快捷入口 + 字数进度可视化 */
.hero-card {
  grid-column: 1 / -1;
  position: relative;
  display: flex;
  align-items: center;
  gap: var(--size-4-4);
  padding: var(--size-4-3) var(--size-4-4);
  border-radius: var(--radius-m);
  background: linear-gradient(135deg, var(--background-secondary-alt), var(--background-secondary));
  border: 1px solid var(--background-modifier-border);
  box-shadow: var(--shadow-s);
  cursor: pointer;
  overflow: hidden;
  transition: transform var(--dur-norm) var(--ease-out), box-shadow var(--dur-norm) var(--ease-out), border-color var(--dur-norm) var(--ease-out);
}
.hero-card::before {
  content: '';
  position: absolute;
  inset: 0;
  border-radius: inherit;
  background: radial-gradient(400px circle at var(--mx, 30%) var(--my, 50%), color-mix(in srgb, var(--text-accent) 10%, transparent), transparent 50%);
  opacity: 0;
  transition: opacity var(--dur-norm) var(--ease-out);
  pointer-events: none;
}
.hero-card:hover::before {
  opacity: 1;
}
.hero-card:hover {
  transform: translateY(-1px);
  border-color: color-mix(in srgb, var(--text-accent) 40%, var(--background-modifier-border));
  box-shadow: var(--shadow-l);
}
.hero-left {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
}
.hero-label {
  font-size: var(--font-size-xs);
  color: var(--text-accent);
  font-weight: 500;
  letter-spacing: 0.06em;
}
.hero-arrow {
  color: var(--text-accent);
  opacity: 0;
  transform: translateX(-4px);
  transition: opacity var(--dur-norm) var(--ease-out), transform var(--dur-norm) var(--ease-out);
}
.hero-card:hover .hero-arrow {
  opacity: 1;
  transform: translateX(0);
}
.hero-mid {
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-width: 0;
  flex: 1;
}
.hero-title {
  margin: 0;
  font-size: var(--font-size-xl);
  font-weight: 600;
  letter-spacing: -0.015em;
  color: var(--text-normal);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.hero-recent {
  margin: 0;
  font-size: var(--font-size-xs);
  color: var(--text-faint);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.hero-prog {
  display: flex;
  flex-direction: column;
  gap: 4px;
  width: 180px;
  flex-shrink: 0;
}
.progress-bar {
  height: 4px;
  border-radius: var(--radius-s);
  background: var(--background-modifier-hover);
  overflow: hidden;
}
.progress-fill {
  height: 100%;
  border-radius: var(--radius-s);
  background: var(--text-accent);
  transition: width var(--dur-slow) var(--ease-out);
}
.progress-text {
  font-size: 10px;
  color: var(--text-faint);
  font-variant-numeric: tabular-nums;
}
.hero-foot {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 2px;
  font-size: var(--font-size-xs);
  color: var(--text-muted);
  font-variant-numeric: tabular-nums;
  flex-shrink: 0;
}
.hero-time {
  color: var(--text-faint);
}
/* 列表模式 hero：紧凑单行，匹配列表风格 */
.hero-list {
  grid-column: 1 / -1;
  position: relative;
  display: flex;
  align-items: center;
  gap: var(--size-4-3);
  padding: var(--size-4-2) var(--size-4-3);
  border-radius: var(--radius-m);
  border: 1px solid var(--background-modifier-border);
  background: var(--background-secondary);
  cursor: pointer;
  text-align: left;
  color: var(--text-normal);
  overflow: hidden;
  transition: border-color var(--dur-fast) var(--ease-out);
}
.hero-list::before {
  content: '';
  position: absolute;
  inset: 0;
  border-radius: inherit;
  background: radial-gradient(300px circle at var(--mx, 30%) var(--my, 50%), color-mix(in srgb, var(--text-accent) 8%, transparent), transparent 50%);
  opacity: 0;
  transition: opacity var(--dur-norm) var(--ease-out);
  pointer-events: none;
}
.hero-list:hover::before {
  opacity: 1;
}
.hero-list:hover {
  border-color: color-mix(in srgb, var(--text-accent) 30%, var(--background-modifier-border));
}
.hero-list-label {
  font-size: var(--font-size-xs);
  color: var(--text-accent);
  font-weight: 500;
  letter-spacing: 0.06em;
  flex-shrink: 0;
}
.hero-list-name {
  font-size: var(--font-size-m);
  font-weight: 600;
  color: var(--text-normal);
  white-space: nowrap;
}
.hero-list-recent {
  font-size: var(--font-size-xs);
  color: var(--text-faint);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.hero-list-meta {
  display: flex;
  align-items: center;
  gap: var(--size-4-2);
  margin-left: auto;
  font-size: var(--font-size-xs);
  color: var(--text-muted);
  font-variant-numeric: tabular-nums;
  flex-shrink: 0;
}
.hero-list-arrow {
  color: var(--text-accent);
  flex-shrink: 0;
}
.book-section {
  display: flex;
  flex-direction: column;
  gap: var(--size-4-3);
}
.section-head {
  display: flex;
  align-items: baseline;
  gap: var(--size-4-2);
}
.section-title {
  margin: 0;
  font-size: var(--font-size-m);
  font-weight: 600;
  letter-spacing: -0.01em;
  color: var(--text-normal);
}
.section-count {
  font-size: var(--font-size-xs);
  color: var(--text-faint);
  font-variant-numeric: tabular-nums;
}

/* 网格卡片：Linear 风——渐变 + hover 鼠标跟随柔光晕 + 进入箭头 */
.book-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
  gap: var(--size-4-3);
}
.book-card {
  position: relative;
  display: flex;
  flex-direction: column;
  padding: var(--size-4-3);
  border-radius: var(--radius-m);
  background: linear-gradient(180deg, var(--background-secondary-alt), var(--background-secondary));
  border: 1px solid var(--background-modifier-border);
  box-shadow: var(--shadow-s);
  min-height: 96px;
  cursor: pointer;
  text-align: left;
  color: var(--text-normal);
  overflow: hidden;
  transition: transform var(--dur-norm) var(--ease-out), box-shadow var(--dur-norm) var(--ease-out), border-color var(--dur-norm) var(--ease-out);
}
.book-card::before {
  content: '';
  position: absolute;
  inset: 0;
  border-radius: inherit;
  background: radial-gradient(300px circle at var(--mx, 50%) var(--my, 50%), color-mix(in srgb, var(--text-accent) 14%, transparent), transparent 45%);
  opacity: 0;
  transition: opacity var(--dur-norm) var(--ease-out);
  pointer-events: none;
}
.book-card:hover::before {
  opacity: 1;
}
.book-card:hover {
  transform: translateY(-2px);
  border-color: color-mix(in srgb, var(--text-accent) 40%, var(--background-modifier-border));
  box-shadow: var(--shadow-l);
}
.card-arrow {
  position: absolute;
  top: var(--size-4-3);
  right: var(--size-4-3);
  color: var(--text-accent);
  opacity: 0;
  transform: translateX(-4px);
  transition: opacity var(--dur-norm) var(--ease-out), transform var(--dur-norm) var(--ease-out);
}
.book-card:hover .card-arrow {
  opacity: 1;
  transform: translateX(0);
}
.book-title {
  margin: 0;
  padding-right: var(--size-4-4);
  font-size: var(--font-size-m);
  font-weight: 600;
  letter-spacing: -0.01em;
  line-height: 1.3;
  color: var(--text-normal);
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.card-foot {
  margin-top: auto;
  padding-top: var(--size-4-2);
  border-top: 1px solid var(--background-modifier-border);
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.card-stats {
  display: flex;
  justify-content: space-between;
  font-size: var(--font-size-xs);
  color: var(--text-muted);
  font-variant-numeric: tabular-nums;
}
.book-time {
  font-size: 10px;
  color: var(--text-faint);
}

/* 列表视图：表格化——表头 + grid 列对齐 + hover 高亮 */
.book-list {
  display: flex;
  flex-direction: column;
}
.list-head,
.list-row {
  display: grid;
  grid-template-columns: 1fr 56px 72px 72px 18px;
  align-items: center;
  gap: var(--size-4-2);
  padding: 0 var(--size-4-2);
}
.list-head {
  padding-top: var(--size-4-1);
  padding-bottom: var(--size-4-1);
  font-size: 10px;
  color: var(--text-faint);
  letter-spacing: 0.04em;
  font-variant-numeric: tabular-nums;
  border-bottom: 1px solid var(--background-modifier-border);
  margin-bottom: 2px;
}
.list-row {
  position: relative;
  padding-top: var(--size-4-2);
  padding-bottom: var(--size-4-2);
  background: transparent;
  border: none;
  border-bottom: 1px solid var(--background-modifier-border);
  cursor: pointer;
  text-align: left;
  color: var(--text-normal);
  overflow: hidden;
}
.list-row:last-child {
  border-bottom: none;
}
.list-row::before {
  content: '';
  position: absolute;
  inset: 0;
  border-radius: inherit;
  background: radial-gradient(200px circle at var(--mx, 50%) var(--my, 50%), color-mix(in srgb, var(--text-accent) 8%, transparent), transparent 50%);
  opacity: 0;
  transition: opacity var(--dur-norm) var(--ease-out);
  pointer-events: none;
}
.list-row:hover::before {
  opacity: 1;
}
.list-row:hover .list-name {
  color: var(--text-accent);
}
.col-name {
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-width: 0;
}
.list-name {
  font-size: var(--font-size-s);
  font-weight: 500;
  color: var(--text-normal);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.list-recent {
  font-size: 10px;
  color: var(--text-faint);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.col-num {
  font-size: var(--font-size-xs);
  color: var(--text-muted);
  font-variant-numeric: tabular-nums;
  text-align: right;
  white-space: nowrap;
}
.col-edited {
  font-size: var(--font-size-xs);
  color: var(--text-faint);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.list-arrow {
  color: var(--text-faint);
  opacity: 0;
  transition: opacity var(--dur-fast) var(--ease-out);
}
.list-row:hover .list-arrow {
  opacity: 1;
  color: var(--text-accent);
}

/* 新建书弹窗（浮层内，z 高于 shelf-modal）*/
.create-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.3);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 160;
}
.create-modal {
  background: var(--background-primary);
  border: 1px solid var(--background-modifier-border);
  border-radius: var(--radius-l);
  padding: var(--size-4-4);
  width: 320px;
  box-shadow: var(--shadow-l);
  animation: clw-appear var(--dur-norm) var(--ease-out);
}
.create-modal h3 {
  margin: 0 0 var(--size-4-3);
  font-size: var(--font-size-m);
  font-weight: 600;
}
.input {
  width: 100%;
  padding: 7px var(--size-4-2);
  border: 1px solid var(--background-modifier-border);
  border-radius: var(--radius-s);
  background: var(--background-primary);
  color: var(--text-normal);
  font-size: var(--font-size-s);
  box-sizing: border-box;
}
.input:focus {
  outline: none;
  border-color: var(--interactive-accent);
}
.create-actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--size-4-2);
  margin-top: var(--size-4-3);
}
.err {
  color: var(--text-error);
  font-size: 11px;
  margin-top: var(--size-4-2);
}

@media (prefers-reduced-motion: reduce) {
  .book-card,
  .shelf-modal,
  .create-modal {
    animation: none;
  }
  .book-card:hover {
    transform: none;
  }
  .card-arrow {
    opacity: 1;
    transform: none;
    transition: none;
  }
  .list-arrow {
    opacity: 1;
    transition: none;
  }
}
</style>
