<script setup lang="ts">
// 书架全屏页（独立窗口或主窗口路由）：书列表 + 开书 + 新建书表单 + workDir 缺失引导。
// 共享逻辑走 useShelf composable，书卡走 BookCard 组件；本页只保留全屏布局 + IPC 跳转。
import { onMounted, computed } from 'vue'
import { useRouter } from 'vue-router'
import { Sun, Moon, BookOpen, ArrowRight, LayoutGrid, List, Plus } from 'lucide-vue-next'
import { useShelf, formatWords, formatRelative, progressPercent, onCardMove } from '../composables/useShelf'
import { useTheme } from '../composables/useTheme'
import BookCard from '../components/ui/BookCard.vue'
import EmptyState from '../components/ui/EmptyState.vue'

const router = useRouter()
const { theme, toggle } = useTheme()
const hasDesktop = typeof window !== 'undefined' && !!window.clwritingDesktop
const {
  shelf, groups, latestBook, viewMode, setView,
  showCreate, newName, creating, createError, createBook,
} = useShelf({
  onCreated: (name) => router.push(`/book/${encodeURIComponent(name)}`),
})

// Awwwards 冲击面：hero 数据条展示创作概况
const totalWords = computed(() => shelf.books.reduce((s, b) => s + (b.words ?? 0), 0))
const lastEdited = computed(() => {
  const ts = shelf.books
    .map((b) => (b.lastEdited ? new Date(b.lastEdited).getTime() : 0))
    .filter(Boolean)
  return ts.length ? new Date(Math.max(...ts)).toISOString() : null
})

onMounted(() => shelf.load())

function openBook(name: string): void {
  // 记住最近打开的书（主窗口启动直进工作区用）
  try {
    localStorage.setItem('clw-last-book', name)
  } catch {
    /* localStorage 不可用时忽略 */
  }
  // 书架独立窗口（win=shelf）：IPC 通知主窗口打开 + 关闭书架窗口；主窗口内：路由跳转
  const isShelfWin = new URLSearchParams(location.search).get('win') === 'shelf'
  if (isShelfWin && window.clwritingDesktop) {
    void window.clwritingDesktop.openBook(name)
  } else {
    router.push(`/book/${encodeURIComponent(name)}`)
  }
}
</script>

<template>
  <div class="shelf" :class="{ 'has-traffic': hasDesktop }">
    <header class="shelf-titlebar" />
    <main class="shelf-main">
      <header class="shelf-head">
        <div class="head-left">
          <h1 class="head-title">书架</h1>
          <p v-if="shelf.books.length" class="head-sub">
            <span class="sub-num">{{ shelf.books.length }}</span> 部<span class="dot">·</span><span class="sub-num">{{ formatWords(totalWords) }}</span><template v-if="lastEdited"><span class="dot">·</span>最近 {{ formatRelative(lastEdited) }}</template>
          </p>
          <p v-else class="head-sub">开启你的长篇之旅</p>
        </div>
        <div class="shelf-actions">
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
            :data-tip="theme === 'dark' ? '切到亮色' : '切到暗色'"
            @click="toggle($event)"
          >
            <Moon v-if="theme === 'light'" :size="16" />
            <Sun v-else :size="16" />
          </button>
          <button class="btn primary" @click="showCreate = true"><Plus :size="14" /> 新建书</button>
        </div>
      </header>
      <div v-if="shelf.loading" class="shelf-status">加载中…</div>
      <div v-else-if="shelf.error" class="shelf-status err">{{ shelf.error }}</div>
      <div v-else-if="shelf.workDirMissing" class="shelf-status">
        <p>未打开书库。</p>
        <p class="sub">{{ shelf.hint ?? '请用 clwriting studio --dir &lt;书库目录&gt; 指定书库。' }}</p>
      </div>
      <EmptyState
        v-else-if="!shelf.books.length"
        :icon="BookOpen"
        title="书库还是空的"
        text="建第一本书，开始你的长篇之旅"
        size="full"
      >
        <button class="btn primary" @click="showCreate = true"><Plus :size="14" /> 新建书</button>
      </EmptyState>
      <template v-else>
        <section
          v-if="latestBook && viewMode === 'grid'"
          class="hero-card"
          @mousemove="onCardMove"
          @click="openBook(latestBook.name)"
        >
          <div class="hero-top">
            <span class="hero-label">继续写作</span>
            <ArrowRight :size="18" class="hero-arrow" />
          </div>
          <h2 class="hero-title">{{ latestBook.title ?? latestBook.name }}</h2>
          <p v-if="latestBook.latestChapter" class="hero-recent">
            最近 · {{ latestBook.latestChapter }}
          </p>
          <div v-if="latestBook.targetWords" class="hero-progress">
            <div class="progress-bar">
              <div class="progress-fill" :style="{ width: progressPercent(latestBook) + '%' }" />
            </div>
            <span class="progress-text">
              {{ formatWords(latestBook.words) }} / {{ formatWords(latestBook.targetWords) }}
            </span>
          </div>
          <div class="hero-foot">
            <span>{{ latestBook.chapters ?? 0 }} {{ latestBook.kind === 'short' ? '篇' : '章' }}</span>
            <span v-if="latestBook.lastEdited" class="hero-time"
              ><span class="dot">·</span>{{ formatRelative(latestBook.lastEdited) }}</span
            >
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
        <div class="shelf-list">
        <section v-for="grp in groups" :key="grp.title" class="book-section">
          <header class="section-head">
            <h2 class="section-title">{{ grp.title }}</h2>
            <span class="section-count">{{ grp.books.length }} 部</span>
          </header>
          <div v-if="viewMode === 'grid'" class="book-grid">
            <BookCard
              v-for="(b, i) in grp.books"
              :key="b.name"
              :book="b"
              variant="grid"
              :index="i"
              @move="onCardMove"
              @click="openBook"
            />
          </div>
          <div v-else class="book-list">
            <div class="list-head">
              <span class="col-name">名称</span>
              <span class="col-num">章节</span>
              <span class="col-num">字数</span>
              <span class="col-edited">最近编辑</span>
            </div>
            <BookCard
              v-for="b in grp.books"
              :key="b.name"
              :book="b"
              variant="list"
              @move="onCardMove"
              @click="openBook"
            />
          </div>
        </section>
        </div>
      </template>
    </main>

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
  min-height: 100vh;
  display: flex;
  flex-direction: column;
  /* 紧凑模式：独立书架窗口缩小后，字号/间距 token 同比例缩 ~0.85，
     子元素 var() 自动继承；硬编码 px（卡片 min-height / grid minmax）单独改 */
  --font-size-2xl: 20px;
  --font-size-xl: 15px;
  --font-size-l: 13px;
  --font-size-m: 12px;
  --font-size-s: 11px;
  --font-size-xs: 10px;
  --size-4-1: 3px;
  --size-4-2: 7px;
  --size-4-3: 10px;
  --size-4-4: 14px;
  --size-4-5: 17px;
  --size-4-6: 20px;
  --size-4-7: 24px;
  --size-4-8: 27px;
  --size-4-10: 34px;
  --size-4-12: 41px;
  --size-4-14: 48px;
  --size-4-16: 54px;
  /* BookCard 尺寸覆盖（全屏页用大卡片）*/
  --shelf-card-pad: var(--size-4-4);
  --shelf-card-radius: var(--radius-l);
  --shelf-card-min-h: 116px;
  --shelf-card-line-clamp: 1;
  --shelf-card-anim: clw-card-in var(--dur-norm) var(--ease-out) both;
  --shelf-title-fs: var(--font-size-xl);
  --shelf-list-cols: 1fr 72px 92px 96px 20px;
}
/* 顶部 titlebar：纯窗口拖动区（桌面版可拖动整窗），不放内容。*/
.shelf-titlebar {
  height: var(--size-tabbar);
  flex-shrink: 0;
  border-bottom: 1px solid var(--background-modifier-border);
  background: var(--background-primary);
}
.shelf.has-traffic .shelf-titlebar {
  -webkit-app-region: drag;
}
/* 主体 header：标题（上）+ 数据副标题（下）两行编辑式排版；操作底对齐 */
.shelf-head {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: var(--size-4-4);
  margin-bottom: var(--size-4-7);
}
.head-left {
  display: flex;
  flex-direction: column;
  gap: var(--size-4-2);
  min-width: 0;
}
.head-title {
  margin: 0;
  font-size: var(--font-size-2xl);
  font-weight: 700;
  letter-spacing: -0.03em;
  line-height: 1.1;
  color: var(--text-normal);
}
.head-sub {
  margin: 0;
  font-size: var(--font-size-m);
  color: var(--text-muted);
  font-variant-numeric: tabular-nums;
  letter-spacing: 0.01em;
}
/* 数据副标题里的数字 / 字数整体提亮，比 label 更有视觉重量 */
.head-sub .sub-num {
  color: var(--text-normal);
  font-weight: 500;
}
.head-sub .dot {
  margin: 0 var(--size-4-2);
  color: var(--text-faint);
  opacity: 0.6;
}
.shelf-main {
  flex: 1;
  width: 100%;
  max-width: 1080px;
  margin: 0 auto;
  padding: var(--size-4-12) var(--size-4-8) var(--size-4-16);
}
.shelf-actions {
  display: flex;
  align-items: center;
  gap: var(--size-4-2);
}
/* 视图切换（网格/列表）segmented control */
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
/* 继续写作 hero 卡：横跨整宽，最近编辑书的快捷入口 + 字数进度可视化 */
.hero-card {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: var(--size-4-2);
  padding: var(--size-4-6);
  margin-bottom: var(--size-4-10);
  border-radius: var(--radius-l);
  background: linear-gradient(135deg, var(--background-secondary-alt), var(--background-secondary));
  border: 1px solid var(--background-modifier-border);
  box-shadow: var(--shadow-m);
  cursor: pointer;
  overflow: hidden;
  transition: transform var(--dur-norm) var(--ease-out), box-shadow var(--dur-norm) var(--ease-out), border-color var(--dur-norm) var(--ease-out);
}
.hero-card::before {
  content: '';
  position: absolute;
  inset: 0;
  border-radius: inherit;
  background: radial-gradient(600px circle at var(--mx, 30%) var(--my, 30%), color-mix(in srgb, var(--text-accent) 10%, transparent), transparent 50%);
  opacity: 0;
  transition: opacity var(--dur-norm) var(--ease-out);
  pointer-events: none;
}
.hero-card:hover::before {
  opacity: 1;
}
.hero-card:hover {
  transform: translateY(-2px);
  border-color: color-mix(in srgb, var(--text-accent) 40%, var(--background-modifier-border));
  box-shadow: var(--shadow-l);
}
.hero-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.hero-label {
  font-size: var(--font-size-xs);
  color: var(--text-accent);
  font-weight: 500;
  letter-spacing: 0.08em;
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
.hero-title {
  margin: 0;
  font-size: var(--font-size-2xl);
  font-weight: 700;
  letter-spacing: -0.025em;
  line-height: 1.2;
  color: var(--text-normal);
}
.hero-recent {
  margin: 0;
  font-size: var(--font-size-m);
  color: var(--text-muted);
}
.hero-progress {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-top: var(--size-4-2);
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
  font-size: var(--font-size-xs);
  color: var(--text-faint);
  font-variant-numeric: tabular-nums;
}
.hero-foot {
  display: flex;
  align-items: center;
  gap: var(--size-4-2);
  margin-top: var(--size-4-2);
  font-size: var(--font-size-s);
  color: var(--text-muted);
  font-variant-numeric: tabular-nums;
}
.hero-foot .dot {
  color: var(--text-faint);
}

/* 列表模式的 hero：紧凑单行，匹配列表风格（无大渐变/进度条）*/
.hero-list {
  position: relative;
  display: flex;
  align-items: center;
  gap: var(--size-4-3);
  padding: var(--size-4-3) var(--size-4-4);
  margin-bottom: var(--size-4-6);
  border-radius: var(--radius-m);
  border: 1px solid var(--background-modifier-border);
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
  background: radial-gradient(400px circle at var(--mx, 30%) var(--my, 50%), color-mix(in srgb, var(--text-accent) 8%, transparent), transparent 50%);
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
  font-size: var(--font-size-s);
  color: var(--text-faint);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.hero-list-meta {
  display: flex;
  align-items: center;
  gap: var(--size-4-3);
  margin-left: auto;
  font-size: var(--font-size-s);
  color: var(--text-muted);
  font-variant-numeric: tabular-nums;
  flex-shrink: 0;
}
.hero-list-arrow {
  color: var(--text-accent);
  flex-shrink: 0;
}

/* 分组列表：长篇/短篇各自一栏，栏间留白 */
.shelf-list {
  display: flex;
  flex-direction: column;
  gap: var(--size-4-10);
}
.book-section {
  display: flex;
  flex-direction: column;
  gap: var(--size-4-4);
}
.section-head {
  display: flex;
  align-items: baseline;
  gap: var(--size-4-2);
}
.section-title {
  margin: 0;
  font-size: var(--font-size-l);
  font-weight: 600;
  letter-spacing: -0.01em;
  color: var(--text-normal);
}
.section-count {
  font-size: var(--font-size-xs);
  color: var(--text-faint);
  font-variant-numeric: tabular-nums;
}
.book-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(184px, 1fr));
  gap: var(--size-4-4);
}
/* 列表视图：表头 */
.list-head {
  display: grid;
  grid-template-columns: var(--shelf-list-cols, 1fr 56px 72px 72px 18px);
  align-items: center;
  gap: var(--size-4-2);
  padding: var(--size-4-2) var(--size-4-2);
  font-size: var(--font-size-xs);
  color: var(--text-faint);
  letter-spacing: 0.04em;
  font-variant-numeric: tabular-nums;
  border-bottom: 1px solid var(--background-modifier-border);
  margin-bottom: var(--size-4-1);
}
.list-head .col-name,
.list-head .col-num,
.list-head .col-edited {
  font-size: var(--font-size-xs);
}
.list-head .col-name {
  display: block;
}
.list-head .col-num {
  text-align: right;
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
  box-shadow: var(--shadow-l);
}
.modal h2 {
  margin: 0 0 var(--size-4-3);
  font-size: var(--font-size-l);
}
.input {
  width: 100%;
  padding: 8px var(--size-4-2);
  border: 1px solid var(--background-modifier-border);
  border-radius: var(--radius-s);
  background: var(--background-primary);
  color: var(--text-normal);
  font-size: var(--font-size-m);
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
@media (prefers-reduced-motion: reduce) {
  .hero-card:hover {
    transform: none;
  }
  .hero-arrow {
    opacity: 1;
    transform: none;
    transition: none;
  }
}
</style>
