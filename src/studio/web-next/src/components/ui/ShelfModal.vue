<script setup lang="ts">
// 书架浮层（仿设置 modal）：主窗口内 Teleport 浮层，长篇/短篇左右并排。
// 共享逻辑走 useShelf composable，书卡走 BookCard 组件；本组件只保留浮层布局 + 关闭逻辑。
import { ref, onMounted, onBeforeUnmount } from 'vue'
import { useRouter } from 'vue-router'
import { X, BookOpen, ArrowRight, LayoutGrid, List, Sun, Moon, Plus, Trash2, CheckSquare } from 'lucide-vue-next'
import { useShelf, formatWords, formatRelative, progressPercent, onCardMove } from '../../composables/useShelf'
import { useNativeMenu } from '../../composables/useNativeMenu'
import { useUiStore } from '../../stores/ui'
import { useTheme } from '../../composables/useTheme'
import { useFocusTrap } from '../../composables/useFocusTrap'
import ContextMenu, { type MenuItem } from './ContextMenu.vue'
import BookCard from './BookCard.vue'

const router = useRouter()
const ui = useUiStore()
const { theme, toggle } = useTheme()
const {
  shelf, groups, latestBook, viewMode, setView,
  query, sortBy, setSortBy,
  showCreate, newName, newKind, creating, createError, createBook,
  batchMode, selected, toggleSelect, selectAll, enterBatch, exitBatch,
  confirmTarget, deleting, deleteError, requestDelete, confirmDelete, cancelDelete,
} = useShelf({
  onCreated: (name) => {
    ui.closeShelf()
    router.push(`/book/${encodeURIComponent(name)}`)
  },
})

// 右键菜单：桌面端原生 Menu，浏览器回退 ContextMenu
const { isNative, menuVisible, menuX, menuY, menuItems, popup, onPopupSelect, onPopupClose } = useNativeMenu()
const hasDesktop = typeof window !== 'undefined' && !!window.clwritingDesktop
const modalRef = ref<HTMLElement | null>(null)
useFocusTrap(modalRef)

function onCardContextmenu(e: MouseEvent, name: string): void {
  const items: MenuItem[] = [
    { key: 'open', label: '打开' },
    { key: 'sep1', label: '', separator: true },
    { key: 'folder', label: '打开所在文件夹', disabled: !hasDesktop },
    { key: 'sep2', label: '', separator: true },
    { key: 'delete', label: '删除…', danger: true },
  ]
  popup(items, e.clientX, e.clientY, (key) => {
    if (key === 'open') openBook(name)
    else if (key === 'folder') window.clwritingDesktop?.openBookDir(name)
    else if (key === 'delete') requestDelete([name])
  })
}

// 卡片点击：批量模式 toggle 选中，否则打开书
function handleCardClick(name: string): void {
  if (batchMode.value) toggleSelect(name)
  else openBook(name)
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

// Esc 关闭（mask 点击已支持；键盘可达性补全）
function onKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape') {
    if (confirmTarget.value) cancelDelete()
    else if (showCreate.value) showCreate.value = false
    else if (batchMode.value) exitBatch()
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
      <div ref="modalRef" class="shelf-modal" role="dialog" aria-modal="true" aria-label="书库" tabindex="-1">
        <header class="modal-head">
          <div class="head-left">
            <h2 class="head-title">书架</h2>
            <span v-if="!batchMode && shelf.books.length" class="head-count">{{ shelf.books.length }} 部</span>
            <span v-if="batchMode" class="head-batch-count">已选 {{ selected.size }} 本</span>
          </div>
          <div class="head-actions">
            <template v-if="!batchMode">
              <input
                v-model="query"
                class="shelf-search"
                type="search"
                placeholder="搜索书名…"
                aria-label="搜索书名"
              />
              <select
                class="shelf-sort"
                :value="sortBy"
                aria-label="排序方式"
                @change="setSortBy(($event.target as HTMLSelectElement).value as 'recent' | 'created' | 'name')"
              >
                <option value="recent">最近打开</option>
                <option value="created">创建时间</option>
                <option value="name">书名</option>
              </select>
              <div class="view-toggle">
                <button
                  class="toggle-btn"
                  :class="{ active: viewMode === 'grid' }"
                  data-tip="网格视图" data-tip-dir="bottom"
                  @click="setView('grid')"
                >
                  <LayoutGrid :size="15" />
                </button>
                <button
                  class="toggle-btn"
                  :class="{ active: viewMode === 'list' }"
                  data-tip="列表视图" data-tip-dir="bottom"
                  @click="setView('list')"
                >
                  <List :size="15" />
                </button>
              </div>
              <button
                v-if="shelf.books.length"
                class="btn batch-enter"
                data-tip="批量管理" data-tip-dir="bottom"
                @click="enterBatch"
              >
                <CheckSquare :size="14" /> 管理
              </button>
              <button
                class="btn icon"
                :data-tip="theme === 'dark' ? '切到亮色' : '切到暗色'" data-tip-dir="bottom"
                @click="toggle($event)"
              >
                <Moon v-if="theme === 'light'" :size="16" />
                <Sun v-else :size="16" />
              </button>
              <button class="btn primary" @click="showCreate = true"><Plus :size="14" /> 新建书</button>
              <button class="close-btn" data-tip="关闭（Esc）" aria-label="关闭" data-tip-dir="bottom" @click="ui.closeShelf">
                <X :size="18" />
              </button>
            </template>
            <template v-else>
              <button class="btn" :disabled="!shelf.books.length" @click="selectAll">全选</button>
              <button class="btn danger" :disabled="selected.size === 0" @click="requestDelete([...selected])">
                <Trash2 :size="14" /> 删除<span v-if="selected.size" class="del-num">({{ selected.size }})</span>
              </button>
              <button class="btn" @click="exitBatch">完成</button>
            </template>
          </div>
        </header>

        <div class="modal-body">
          <div v-if="shelf.loading" class="shelf-status">加载中…</div>
          <div v-else-if="shelf.error" class="shelf-status err">{{ shelf.error }}</div>
          <div v-else-if="!shelf.books.length" class="shelf-empty">
            <BookOpen :size="40" class="empty-icon" />
            <p class="empty-title">书库还是空的</p>
            <p class="empty-text">建第一本书，开始你的长篇之旅</p>
            <button class="btn primary" @click="showCreate = true"><Plus :size="14" /> 新建书</button>
          </div>
          <div v-else class="groups-grid">
            <section
              v-if="latestBook && viewMode === 'grid' && !batchMode"
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
                <span>{{ latestBook.chapters ?? 0 }} 章</span>
                <span v-if="latestBook.lastEdited" class="hero-time">{{ formatRelative(latestBook.lastEdited) }}</span>
              </div>
            </section>
            <section
              v-else-if="latestBook && !batchMode"
              class="hero-list"
              @mousemove="onCardMove"
              @click="openBook(latestBook.name)"
            >
              <span class="hero-list-label">继续写作</span>
              <span class="hero-list-name">{{ latestBook.title ?? latestBook.name }}</span>
              <span v-if="latestBook.latestChapter" class="hero-list-recent">最近 · {{ latestBook.latestChapter }}</span>
              <span class="hero-list-meta">
                <span>{{ latestBook.chapters ?? 0 }} 章</span>
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
                <BookCard
                  v-for="b in grp.books"
                  :key="b.name"
                  :book="b"
                  variant="grid"
                  :batch-mode="batchMode"
                  :selected="selected.has(b.name)"
                  @move="onCardMove"
                  @click="handleCardClick"
                  @contextmenu="onCardContextmenu($event, b.name)"
                />
              </div>
              <div v-else class="book-list">
                <div class="list-head">
                  <span class="col-name">名称</span>
                  <span class="col-num">章节</span>
                  <span class="col-num">字数</span>
                  <span class="col-edited">最近</span>
                </div>
                <BookCard
                  v-for="b in grp.books"
                  :key="b.name"
                  :book="b"
                  variant="list"
                  :batch-mode="batchMode"
                  :selected="selected.has(b.name)"
                  @move="onCardMove"
                  @click="handleCardClick"
                  @contextmenu="onCardContextmenu($event, b.name)"
                />
              </div>
            </section>
          </div>
        </div>
      </div>

      <!-- 新建书弹窗（浮层内的浮层，z 更高）-->
      <div v-if="showCreate" class="create-overlay" @click.self="showCreate = false">
        <div class="create-modal">
          <h3>新建书</h3>
          <div class="kind-picker">
            <button type="button" :class="['kind-btn', { active: newKind === 'long' }]" @click="newKind = 'long'">
              长篇
            </button>
            <button type="button" :class="['kind-btn', { active: newKind === 'short' }]" @click="newKind = 'short'">
              短篇
            </button>
          </div>
          <input
            v-model="newName"
            class="input"
            placeholder="书名"
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

  <!-- 右键菜单（浏览器回退；桌面端走原生 Menu） -->
  <ContextMenu
    v-if="!isNative"
    :visible="menuVisible"
    :x="menuX"
    :y="menuY"
    :items="menuItems"
    @select="onPopupSelect"
    @close="onPopupClose"
  />

  <!-- 删除确认弹窗 -->
  <Teleport to="body">
    <div v-if="confirmTarget" class="confirm-overlay" @click.self="cancelDelete">
      <div class="confirm-dialog">
        <div class="confirm-head">
          <Trash2 :size="22" class="confirm-icon-danger" />
          <h3>确认删除</h3>
        </div>
        <p class="confirm-text">
          将永久删除以下 {{ confirmTarget.length }} 本书及其全部内容（含定稿、大纲、设定），不可恢复：
        </p>
        <div v-if="deleteError" class="confirm-err">{{ deleteError }}</div>
        <div class="confirm-names">
          <span v-for="n in confirmTarget" :key="n" class="confirm-name">{{ n }}</span>
        </div>
        <div class="confirm-actions">
          <button class="btn" @click="cancelDelete" :disabled="deleting">取消</button>
          <button class="btn danger" @click="confirmDelete" :disabled="deleting">
            {{ deleting ? '删除中…' : '确认删除' }}
          </button>
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
/* ── 搜索 + 排序（P2-PROD-6）── */
.shelf-search {
  width: 140px;
  padding: 5px 10px;
  font-size: var(--font-size-s);
  color: var(--text-normal);
  background: var(--background-secondary);
  border: 1px solid var(--background-modifier-border);
  border-radius: var(--radius-s);
  transition: border-color var(--dur-fast) var(--ease-out);
}
.shelf-search:focus {
  outline: none;
  border-color: var(--interactive-accent);
}
.shelf-sort {
  padding: 5px 8px;
  font-size: var(--font-size-s);
  color: var(--text-normal);
  background: var(--background-secondary);
  border: 1px solid var(--background-modifier-border);
  border-radius: var(--radius-s);
  cursor: pointer;
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
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  padding: 6px 14px;
  border: 1px solid var(--background-modifier-border);
  border-radius: var(--radius-s);
  background: var(--interactive-normal);
  color: var(--text-normal);
  font-size: var(--font-size-m);
  cursor: pointer;
  white-space: nowrap;
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
  font-size: var(--font-size-m);
}

/* 长篇/短篇并排 */
.groups-grid {
  display: flex;
  flex-direction: column;
  gap: var(--size-4-6);
}
/* hero 跨整宽——继续写作快捷入口 + 字数进度可视化 */
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
  font-size: var(--font-size-xxs);
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
/* 列表模式 hero：紧凑单行 */
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
/* 网格容器 */
.book-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
  gap: var(--size-4-3);
}
/* 列表视图表头 */
.book-list {
  display: flex;
  flex-direction: column;
}
.list-head {
  display: grid;
  grid-template-columns: var(--shelf-list-cols, 1fr 56px 72px 72px 18px);
  align-items: center;
  gap: var(--size-4-2);
  padding: var(--size-4-1) var(--size-4-2);
  font-size: var(--font-size-xxs);
  color: var(--text-faint);
  letter-spacing: 0.04em;
  font-variant-numeric: tabular-nums;
  border-bottom: 1px solid var(--background-modifier-border);
  margin-bottom: 2px;
}
.list-head .col-name {
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-width: 0;
}
.list-head .col-num {
  text-align: right;
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
  width: min(320px, calc(100vw - 32px));
  box-shadow: var(--shadow-l);
  animation: clw-appear var(--dur-norm) var(--ease-out);
}
.create-modal h3 {
  margin: 0 0 var(--size-4-3);
  font-size: var(--font-size-m);
  font-weight: 600;
}
.kind-picker {
  display: flex;
  gap: 3px;
  margin-bottom: var(--size-4-2);
  padding: 3px;
  background: var(--background-modifier-border);
  border-radius: var(--radius-s);
}
.kind-btn {
  flex: 1;
  padding: 5px var(--size-4-2);
  border: none;
  border-radius: calc(var(--radius-s) - 2px);
  background: transparent;
  color: var(--text-muted);
  font-size: var(--font-size-s);
  cursor: pointer;
  transition: background var(--dur-fast) var(--ease-out), color var(--dur-fast) var(--ease-out);
}
.kind-btn.active {
  background: var(--background-primary);
  color: var(--text-normal);
  font-weight: 500;
}
.kind-btn:not(.active):hover {
  color: var(--text-normal);
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
  font-size: var(--font-size-xs);
  margin-top: var(--size-4-2);
}

@media (prefers-reduced-motion: reduce) {
  .shelf-modal,
  .create-modal {
    animation: none;
  }
}

/* ── 批量模式：header 内联 ── */
.head-batch-count {
  font-size: var(--font-size-s);
  color: var(--text-accent);
  font-weight: 500;
  font-variant-numeric: tabular-nums;
}
/* 管理按钮：带文字标签，批量入口更醒目 */
.btn.batch-enter {
  font-size: var(--font-size-s);
  gap: 5px;
}
.del-num {
  margin-left: 2px;
  opacity: 0.85;
}

/* ── 危险按钮 ── */
.btn.danger {
  background: var(--text-error);
  border-color: var(--text-error);
  color: #fff;
}
.btn.danger:hover:not(:disabled) {
  filter: brightness(1.1);
}

/* ── 删除确认弹窗 ── */
.confirm-overlay {
  position: fixed;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.5);
  z-index: 300;
  animation: fade-in var(--dur-fast) var(--ease-out);
}
.confirm-dialog {
  width: 380px;
  max-width: 90vw;
  padding: var(--size-4-5);
  border-radius: var(--radius-l);
  background: var(--background-primary);
  border: 1px solid var(--background-modifier-border);
  box-shadow: var(--shadow-xl, 0 20px 60px rgba(0,0,0,0.3));
}
.confirm-head {
  display: flex;
  align-items: center;
  gap: var(--size-4-2);
  margin-bottom: var(--size-4-3);
}
.confirm-icon-danger {
  color: var(--text-error);
  flex-shrink: 0;
}
.confirm-head h3 {
  margin: 0;
  font-size: var(--font-size-l);
  font-weight: 600;
}
.confirm-text {
  margin: 0 0 var(--size-4-3);
  font-size: var(--font-size-s);
  color: var(--text-muted);
  line-height: 1.5;
}
.confirm-names {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-bottom: var(--size-4-4);
  padding: var(--size-4-2);
  border-radius: var(--radius-s);
  background: var(--background-secondary);
  max-height: 120px;
  overflow-y: auto;
}
.confirm-name {
  font-size: var(--font-size-xs);
  color: var(--text-normal);
  padding: 3px 8px;
  border-radius: var(--radius-s);
  background: var(--background-modifier-hover);
}
.confirm-actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--size-4-2);
}
.confirm-err {
  margin: 0 0 var(--size-4-3);
  padding: var(--size-4-2) var(--size-4-3);
  border-radius: var(--radius-s);
  background: color-mix(in srgb, var(--text-error) 10%, transparent);
  color: var(--text-error);
  font-size: var(--font-size-xs);
  line-height: 1.4;
}
@keyframes fade-in {
  from { opacity: 0; }
  to { opacity: 1; }
}
</style>
