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
}>()

const emit = defineEmits<{
  (e: 'open', name: string): void
  (e: 'card-click', name: string): void
  (e: 'delete-request', names: string[]): void
}>()

// 右键菜单：桌面端原生 Menu，浏览器回退 ContextMenu（与壳同构）
const { isNative, menuVisible, menuX, menuY, menuItems, popup, onPopupSelect, onPopupClose } = useNativeMenu()
const hasDesktop = typeof window !== 'undefined' && !!window.clwritingDesktop

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
          v-for="(b, i) in grp.books"
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
          v-for="b in grp.books"
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
