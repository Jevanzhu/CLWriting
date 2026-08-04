<script setup lang="ts">
// 顶栏操作条：新建按钮（split：主钮=新建正文，caret=下拉新建大纲/设定）
//   + 左栏/右栏/专注按钮（标签页已移除，单文档模式）。
// 新建信号通过 workspace store createTick 触发 ChapterTreePanel 执行。
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { FilePlus, ChevronDown, Focus, PanelRight, PanelLeft } from 'lucide-vue-next'
import { useWorkspaceStore, type CreateKind } from '../../stores/workspace'
import { useTreeStore } from '../../stores/tree'

defineProps<{ bookName: string }>()
const ws = useWorkspaceStore()
const tree = useTreeStore()
const hasDesktop = typeof window !== 'undefined' && !!window.clwritingDesktop
// 左栏可见性（含专注模式覆盖）：关闭/专注时 ws-main 左移到交通灯区，lead 需避让
const leftVisible = computed(() => ws.leftOpen && !ws.focusMode)

// --- 新建下拉菜单（split button caret）---
const dropdownOpen = ref(false)
const dropX = ref(0)
const dropY = ref(0)
const caretRef = ref<HTMLElement | null>(null)
// 总纲/世界观为全书唯一单文件：存在则菜单文案改「打开」
const hasSynopsis = computed(() => !!tree.byPath.get('大纲/总纲.md'))
const hasWorldview = computed(() => !!tree.byPath.get('定稿/设定/世界观.md'))

function toggleDropdown(): void {
  if (dropdownOpen.value) {
    dropdownOpen.value = false
    return
  }
  const el = caretRef.value
  if (el) {
    const r = el.getBoundingClientRect()
    dropX.value = r.left
    dropY.value = r.bottom + 4
  }
  dropdownOpen.value = true
}
function pick(kind: CreateKind): void {
  dropdownOpen.value = false
  ws.triggerCreate(kind)
}
function onDocClick(e: MouseEvent): void {
  if (!dropdownOpen.value) return
  const t = e.target as HTMLElement
  if (!t.closest('.new-dropdown') && !t.closest('.tb-caret')) dropdownOpen.value = false
}
onMounted(() => document.addEventListener('click', onDocClick))
onUnmounted(() => document.removeEventListener('click', onDocClick))
</script>

<template>
  <div class="tabbar" :class="{ 'is-drag': hasDesktop, 'avoid-traffic': hasDesktop && !leftVisible }">
    <!-- 最左 lead 区：新建按钮（split）+ 展开左栏（条件） -->
    <div class="tabbar-lead">
      <div class="tb-split">
        <button
          class="tb-btn tb-btn-main"
          data-tip="新建正文" data-tip-dir="bottom"
          @click="ws.triggerCreate('chapter')"
        >
          <FilePlus :size="16" />
        </button>
        <button
          ref="caretRef"
          class="tb-btn tb-caret"
          :class="{ active: dropdownOpen }"
          data-tip="新建…" data-tip-dir="bottom"
          @click.stop="toggleDropdown"
        >
          <ChevronDown :size="16" />
        </button>
      </div>
      <button
        v-if="!ws.leftOpen"
        class="tb-btn"
        data-tip="展开左栏" data-tip-dir="bottom"
        @click="ws.toggleLeft()"
      >
        <PanelLeft :size="16" />
      </button>
    </div>
    <div class="tabbar-spacer" />
    <div class="tabbar-actions">
      <button
        class="tb-btn"
        :class="{ active: ws.focusMode }"
        :data-tip="ws.focusMode ? '退出专注（⌘⇧F）' : '专注模式（⌘⇧F）'"
        data-tip-dir="bottom"
        @click="ws.toggleFocus()"
      >
        <Focus :size="16" />
      </button>
      <button
        v-show="!ws.rightOpen"
        class="tb-btn"
        data-tip="展开右栏" data-tip-dir="bottom"
        @click="ws.toggleRight()"
      >
        <PanelRight :size="16" />
      </button>
    </div>
    <!-- 下拉菜单（Teleport 到 body 脱离 tabbar overflow:hidden 裁剪） -->
    <Teleport to="body">
      <div
        v-if="dropdownOpen"
        class="new-dropdown"
        :style="{ left: dropX + 'px', top: dropY + 'px' }"
      >
        <button class="dd-item" @click="pick('chapter')">正文章节</button>
        <div class="dd-sep">大纲</div>
        <button class="dd-item" @click="pick('chapter-outline')">章纲</button>
        <button class="dd-item" @click="pick('volume-outline')">卷纲</button>
        <button class="dd-item" @click="pick('synopsis')">{{ hasSynopsis ? '打开总纲' : '新建总纲' }}</button>
        <div class="dd-sep">设定</div>
        <button class="dd-item" @click="pick('character')">角色</button>
        <button class="dd-item" @click="pick('item')">物品</button>
        <button class="dd-item" @click="pick('foreshadow')">伏笔</button>
        <button class="dd-item" @click="pick('worldview')">{{ hasWorldview ? '打开世界观' : '新建世界观' }}</button>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.tabbar {
  min-height: var(--size-tabbar);
  display: flex;
  align-items: stretch;
  background: var(--tab-container-background);
  border-bottom: 1px solid var(--background-modifier-border);
  overflow: hidden;
}
/* 桌面版：空白区可拖动整窗（按钮本身可点） */
.tabbar.is-drag {
  -webkit-app-region: drag;
}
/* 桌面版交通灯避让：左栏关闭或专注模式时，lead 区整体右移 52px */
.tabbar.avoid-traffic .tabbar-lead {
  padding-left: 52px;
}
/* 弹性占位区（撑满中间空白，桌面版作为窗口拖拽区） */
.tabbar-spacer {
  flex: 1;
  min-width: 0;
}
/* 最左 lead 区：新建 + 展开左栏。垂直居中，水平 padding 距左缘 */
.tabbar-lead {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 0 var(--size-4-2);
}
.tabbar-lead .tb-btn {
  -webkit-app-region: no-drag;
}
/* 右侧固定按钮区（展开右栏 + 专注）——始终钉在最右 */
.tabbar-actions {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 0 var(--size-4-2);
}
.tabbar-actions .tb-btn {
  -webkit-app-region: no-drag;
}
.tb-btn {
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
.tb-btn:hover {
  background: var(--background-modifier-hover);
  color: var(--text-normal);
}
.tb-btn.active {
  color: var(--text-accent);
}
/* split button：主钮（新建正文）+ caret（出下拉） */
.tb-split {
  display: flex;
  align-items: center;
}
.tb-btn-main {
  border-radius: var(--radius-s) 0 0 var(--radius-s);
}
.tb-caret {
  position: relative;
  width: 22px;
  border-radius: 0 var(--radius-s) var(--radius-s) 0;
  color: var(--text-muted);
}
/* 主钮与箭头间的短分割线（居中细竖线，不顶天立地） */
.tb-caret::before {
  content: '';
  position: absolute;
  left: 0;
  top: 50%;
  transform: translateY(-50%);
  width: 1px;
  height: 14px;
  background: var(--background-modifier-border);
}
.tb-caret.active {
  background: var(--background-modifier-hover);
  color: var(--text-accent);
}
/* 新建下拉菜单 */
.new-dropdown {
  position: fixed;
  z-index: 1000;
  min-width: 148px;
  padding: 4px;
  background: var(--background-primary);
  border: 1px solid var(--background-modifier-border);
  border-radius: var(--radius-m);
  box-shadow: 0 6px 16px rgba(0, 0, 0, 0.18);
}
.dd-item {
  display: flex;
  align-items: center;
  width: 100%;
  padding: 5px 10px;
  border: none;
  background: transparent;
  color: var(--text-normal);
  font-size: var(--font-size-m);
  border-radius: var(--radius-s);
  cursor: pointer;
  text-align: left;
}
.dd-item:hover {
  background: var(--background-modifier-hover);
  color: var(--text-accent);
}
.dd-sep {
  padding: 7px 10px 3px;
  font-size: 11px;
  color: var(--text-faint);
  letter-spacing: 0.04em;
  user-select: none;
}
</style>
