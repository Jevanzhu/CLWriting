<script setup lang="ts">
// 书架浮层（ShelfGrid 去重 P2-5）：主窗口内 Teleport 浮层，长篇/短篇左右并排。
// 共享逻辑走 useShelf composable，书卡/弹层走 ShelfGrid 组件，hero 卡走 components/shelf/；
// 本组件只保留浮层布局 + 关闭逻辑。
import { ref, onMounted, onBeforeUnmount } from 'vue'
import { useRouter } from 'vue-router'
import { X, BookOpen, LayoutGrid, List, Sun, Moon, Plus, Trash2, CheckSquare } from 'lucide-vue-next'
import { useShelf } from '../../composables/useShelf'
import { useUiStore } from '../../stores/ui'
import { useTheme } from '../../composables/useTheme'
import { isImeComposing } from '../../shared/ime'
import { useFocusTrap } from '../../composables/useFocusTrap'
import ShelfGrid from './ShelfGrid.vue'
import ShelfModalHero from '../shelf/ShelfModalHero.vue'
import CreateBookModal from './CreateBookModal.vue'
import ConfirmDeleteModal from './ConfirmDeleteModal.vue'

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
  // R65-54（E-6）：浮层内删掉当前打开的书 → 离开死路由（留在 /book/:name 上后续
  // API 全 404），并清 clw-last-book（下次启动不再落进已删书）
  onDeleted: (names) => {
    const current = router.currentRoute.value.params.name
    if (typeof current !== 'string') return
    const currentName = decodeURIComponent(current)
    if (!names.includes(currentName)) return
    try {
      if (localStorage.getItem('clw-last-book') === currentName) localStorage.removeItem('clw-last-book')
    } catch { /* 忽略 */ }
    ui.closeShelf()
    router.replace('/shelf')
  },
})

// R37-30（三十七轮批E）：删 hasDesktop 死变量——J5 平台判断收敛到 usePlatform 后残留零消费
const modalRef = ref<HTMLElement | null>(null)
useFocusTrap(modalRef)

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
  // R75-E-P3e：IME 组合期 Esc 让渡（CommandPalette R61-3 先例）——搜索框收输入法
  // 候选框的 Esc 不应关浮层/收批量（isComposing || keyCode 229 单源判据）
  if (isImeComposing(e)) return
  if (e.key !== 'Escape') return
  // R42-30（四十二轮）：其它 overlay 开着则让渡——对齐 useHotkeys 的 overlayOpen 名单
  // 口径（palette/全局确认/设置/导出；书架自身除外）：压在书架上方的顶层弹层先收 Esc，
  // 本层子态（删除确认/新建/批量）与收层全部不动、不 preventDefault
  if (ui.paletteOpen || ui.confirmState !== null || ui.settingsOpen || ui.exportOpen) return
  // 本组件常驻挂载（WorkspaceShell 无 v-if）——只有实际消费（书架开或子态在）才
  // preventDefault；否则让 Esc 落到 useHotkeys（专注模式退出），同一按键不双效
  let consumed = false
  if (confirmTarget.value) { cancelDelete(); consumed = true }
  else if (showCreate.value) { showCreate.value = false; consumed = true }
  else if (batchMode.value) { exitBatch(); consumed = true }
  else if (ui.shelfOpen) { ui.closeShelf(); consumed = true }
  if (consumed) e.preventDefault() // Z-23（第五十八轮）
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
            <ShelfModalHero
              v-if="latestBook && !batchMode"
              :book="latestBook"
              :view-mode="viewMode"
              @open="openBook"
            />
            <ShelfGrid
              :groups="groups"
              :view-mode="viewMode"
              :batch-mode="batchMode"
              :selected="selected"
              @open="openBook"
              @card-click="handleCardClick"
              @delete-request="requestDelete"
            />
          </div>
        </div>
      </div>

      <!-- 新建书 + 删除确认（壳级：空书架也需可用，故不放 ShelfGrid 内） -->
      <CreateBookModal
        v-if="showCreate"
        :name="newName"
        :kind="newKind"
        :creating="creating"
        :error="createError"
        @update:name="newName = $event"
        @update:kind="newKind = $event"
        @create="createBook"
        @cancel="showCreate = false"
      />
      <ConfirmDeleteModal
        v-if="confirmTarget"
        :names="confirmTarget"
        :deleting="deleting"
        :error="deleteError"
        @confirm="confirmDelete"
        @cancel="cancelDelete"
      />
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

@media (prefers-reduced-motion: reduce) {
  .shelf-modal {
    animation: none;
  }
}
</style>
