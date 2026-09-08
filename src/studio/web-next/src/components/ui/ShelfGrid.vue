<script setup lang="ts">
// 书架共享网格（Shelf/ShelfModal 去重 P2-5）：书卡分组（网格/列表）+ 右键菜单。
// 状态来自壳（useShelf composable 实例），本组件只做渲染 + 事件冒泡；两壳差异（容器/hero/工具栏/新建书/删除确认）留在各自壳内。
import { useUiStore } from '../../stores/ui'
import { friendlyError } from '../../shared/error'
import { useNativeMenu } from '../../composables/useNativeMenu'
import { onCardMove } from '../../composables/useShelf'
import ContextMenu, { type MenuItem } from './ContextMenu.vue'
import BookCard from './BookCard.vue'
import type { BookEntry } from '../../api/shelf'

const ui = useUiStore()

const props = defineProps<{
  groups: { title: string; books: BookEntry[] }[]
  viewMode: 'grid' | 'list'
  batchMode: boolean
  selected: Set<string>
  /** R-P3-4：每组渲染上限；不传 = 不裁（整页书架 Shelf.vue 维持全量渲染） */
  renderCap?: number
}>()

const emit = defineEmits<{
  (e: 'open', name: string): void
  (e: 'card-click', name: string): void
  (e: 'delete-request', names: string[]): void
}>()

// 右键菜单：桌面端原生 Menu，浏览器回退 ContextMenu（与壳同构）
const { isNative, menuVisible, menuX, menuY, menuItems, popup, onPopupSelect, onPopupClose } = useNativeMenu()
const hasDesktop = typeof window !== 'undefined' && !!window.clwritingDesktop

// R-P3-4：大书架渲染上限——书卡树一次性全量挂载，数百书拖慢浮层挂载。对齐
// CommandPalette RENDER_CAP=100 先例：数据面不动（props.groups 的搜索/排序/批量全选/
// 分组计数仍面向全量），只裁渲染面——renderCap 传入时每组只渲染前 N 张书卡 + 尾部
// 「已省略 N 部」提示行（上限数值由壳定，ShelfModal 传 100；不传即不裁，Shelf.vue
// 行为不变）。搜索过滤后的命中 >上限时同样截断且提示行如实计数，缩小搜索词即可见
// 全部命中。
function shownBooks(grp: { books: BookEntry[] }): BookEntry[] {
  if (props.renderCap === undefined || grp.books.length <= props.renderCap) return grp.books
  return grp.books.slice(0, props.renderCap)
}
function omittedCount(grp: { books: BookEntry[] }): number {
  if (props.renderCap === undefined) return 0
  return Math.max(0, grp.books.length - props.renderCap)
}

function onCardContextmenu(e: MouseEvent, name: string): void {
  const items: MenuItem[] = [
    { key: 'open', label: '打开' },
    { key: 'sep1', label: '', separator: true },
    { key: 'folder', label: '打开所在文件夹', disabled: !hasDesktop },
    { key: 'sep2', label: '', separator: true },
    { key: 'delete', label: '删除…', danger: true },
  ]
  popup(items, e.clientX, e.clientY, (key) => {
    if (key === 'open') emit('open', name)
    // R33D-31：IPC 失败 toast 交代
    else if (key === 'folder') window.clwritingDesktop?.openBookDir(name).catch((e: unknown) => ui.toast(friendlyError(e), 'error'))
    else if (key === 'delete') emit('delete-request', [name])
  })
}
</script>

<template>
  <!-- 书卡分组：长篇/短篇各自一栏 -->
  <div class="shelf-groups">
    <section v-for="grp in props.groups" :key="grp.title" class="book-section">
      <header class="section-head">
        <h3 class="section-title">{{ grp.title }}</h3>
        <span class="section-count">{{ grp.books.length }} 部</span>
      </header>
      <div v-if="props.viewMode === 'grid'" class="book-grid">
        <BookCard
          v-for="(b, i) in shownBooks(grp)"
          :key="b.name"
          :book="b"
          variant="grid"
          :index="i"
          :batch-mode="props.batchMode"
          :selected="props.selected.has(b.name)"
          @move="onCardMove"
          @click="emit('card-click', $event)"
          @contextmenu="onCardContextmenu($event, b.name)"
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
          v-for="b in shownBooks(grp)"
          :key="b.name"
          :book="b"
          variant="list"
          :batch-mode="props.batchMode"
          :selected="props.selected.has(b.name)"
          @move="onCardMove"
          @click="emit('card-click', $event)"
          @contextmenu="onCardContextmenu($event, b.name)"
        />
      </div>
      <!-- R-P3-4：渲染上限截断提示行（与 CommandPalette 尾部省略行同语义；分组头计数仍显全量） -->
      <div v-if="omittedCount(grp) > 0" class="cap-hint">
        已省略 {{ omittedCount(grp) }} 部，搜索书名可缩小范围
      </div>
    </section>
  </div>

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
</template>

<style scoped>
/* ── 分组列表 ── */
.shelf-groups {
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
/* R-P3-4：渲染上限截断提示行——纯展示不可点（弱化色，对齐 ChapterTreeItem cap-hint 口径） */
.cap-hint {
  padding-top: var(--size-4-2);
  font-size: var(--font-size-xs);
  color: var(--text-faint);
}
.book-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(184px, 1fr));
  gap: var(--size-4-4);
}
/* 列表视图：表头 */
.book-list {
  display: flex;
  flex-direction: column;
}
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
</style>
