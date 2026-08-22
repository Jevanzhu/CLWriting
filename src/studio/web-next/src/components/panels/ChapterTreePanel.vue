<script setup lang="ts">
import { ref, watch, computed, onMounted, onUnmounted } from 'vue'
import { useTreeStore } from '../../stores/tree'
import { useDocStore } from '../../stores/doc'
import { useWorkspaceStore } from '../../stores/workspace'
import { useWordsStore } from '../../stores/words'
import type { TreeNode } from '../../types/tree'
import ContextMenu from '../ui/ContextMenu.vue'
import { useNativeMenu } from '../../composables/useNativeMenu'
import { useTreeMenu } from '../../composables/useTreeMenu'
import { useChapterTreeActions } from '../../composables/useChapterTreeActions'
import { defaultExpandedDirs } from '../../shared/chapter-tree'
import ChapterTreeItem from './ChapterTreeItem.vue'
import ChapterMetaDialog from './ChapterMetaDialog.vue'
import { friendlyError } from '../../shared/error'

// 章节树面板：GET /tree → groupTree 分组 → 递归渲染 + 六态角标 + 展开态持久化
//   + 右键菜单（五类）+ inline 新建/重命名 + 删除/移动 + 拖拽移动。
// Z-P2-10 拆分：纯工具 → shared/chapter-tree.ts；菜单构建 → useTreeMenu；
//   CRUD 动作 → useChapterTreeActions；本组件只留装配/模板/生命周期。

const props = defineProps<{ bookName: string }>()
const tree = useTreeStore()
const words = useWordsStore()
const doc = useDocStore()
const ws = useWorkspaceStore()

const expanded = computed<Set<string>>(() => new Set(ws.treeExpanded))
const openError = ref<string | null>(null)

const activePath = computed<string | null>(
  () => (ws.activeDocId ? doc.get(ws.activeDocId)?.path ?? null : null),
)

// --- 右键菜单（构建 + 原生/浏览器分派）---
const menuNode = ref<TreeNode | null>(null)
const { isNative, menuVisible, menuX, menuY, menuItems, popup, onPopupSelect, onPopupClose } = useNativeMenu()
const menu = useTreeMenu(() => ({ grouped: tree.grouped, raw: tree.raw }))

// --- CRUD 动作（inline 新建/重命名/删除/移动/复制/篇章信息/批量定稿 + 菜单分发）---
const actions = useChapterTreeActions({
  bookName: () => props.bookName,
  openError,
})

function toggle(path: string): void {
  const next = new Set(expanded.value)
  if (next.has(path)) next.delete(path)
  else next.add(path)
  ws.treeExpanded = [...next]
}

async function onSelect(node: TreeNode): Promise<void> {
  if (node.isDirectory || !node.docId) return
  openError.value = null
  try {
    await doc.open(node)
    ws.openTab(node.docId)
  } catch (e) {
    openError.value = friendlyError(e)
  }
}

function onContextMenu(node: TreeNode, x: number, y: number): void {
  const items = menu.buildMenuItems(node)
  if (!items.length) return
  menuNode.value = node
  popup(items, x, y, (key) => actions.onMenuSelect(key, menuNode.value))
}
function onBlankContextMenu(e: MouseEvent): void {
  // 节点项 contextmenu 冒泡到此：节点 handler 已设对应菜单，跳过避免被空白菜单覆盖
  if ((e.target as HTMLElement).closest('.tree-item')) return
  e.preventDefault()
  menuNode.value = null
  // 空白处 = 「还没想好建在哪」：8 种新建选项直接摊开在顶层（blankItems 已按正文/大纲/设定三组分隔），
  // 不缩进「新建」子菜单——空白处就一个动作，多一级点击是噪音
  popup(menu.blankItems, e.clientX, e.clientY, (key) => actions.onMenuSelect(key, menuNode.value))
}

watch(
  () => props.bookName,
  async (name, old) => {
    // N-13（第十二轮）：切书先清内联编辑态——creating/renamePath/metaEditing/draggedPath
    // 挂的是旧书路径/docId，留着会在新树渲染出无主输入框/弹窗（immediate 首跑 old 为
    // undefined 时无旧态可清，跳过）
    if (old !== undefined && old !== name) actions.resetInlineState()
    if (!name) return
    await tree.load(name, true) // 切书：重扫盘（上次会话期间盘上可能被外部改过）
    // 首次打开（无持久化展开状态）→ 一级目录 + 写作/正文
    if (ws.treeExpanded.length <= 1) {
      ws.treeExpanded = defaultExpandedDirs(tree.grouped)
    }
    // 今日基线：tree.load 后 totalWords 已就绪（§5.4），不阻塞树渲染
    void words.ensureBaseline(name)
  },
  { immediate: true },
)

// 窗口回前台 → 重扫盘。外部编辑器 / CLI / AI 写的文件不经 invalidateTreeIndex，
// 服务端树缓存不会自己失效；切回 app 是「想看到最新状态」的最强信号。
// 节流 2s：避免频繁切窗口时反复触发全盘扫描（buildTree 含 git status + 字数统计）。
let lastRefresh = 0
function onWindowFocus(): void {
  if (!props.bookName) return
  const now = performance.now()
  if (now - lastRefresh < 2000) return
  lastRefresh = now
  void tree.load(props.bookName, true)
}
onMounted(() => window.addEventListener('focus', onWindowFocus))
onUnmounted(() => window.removeEventListener('focus', onWindowFocus))

// TabBar 新建信号 → 监听 createTick 按 createKind 分派（首次 tick=0 不触发，跳过初始）
watch(
  () => ws.createTick,
  (n, old) => {
    if (old !== undefined && n > old) actions.dispatchCreate(ws.createKind)
  },
)
</script>

<template>
  <div class="chapter-tree" @contextmenu="onBlankContextMenu($event)">
    <div v-if="tree.loading" class="hint">加载中…</div>
    <div v-else-if="tree.error" class="hint err">{{ tree.error }}</div>
    <div v-else-if="!tree.grouped.length" class="hint">（无章节）</div>
    <div v-else class="tree-list">
      <ChapterTreeItem
        v-for="n in tree.grouped"
        :key="n.path"
        :node="n"
        :depth="0"
        :expanded="expanded"
        :active-path="activePath"
        :creating-dir-path="actions.creating.value?.renderDir ?? null"
        :creating-kind="actions.creating.value?.kind ?? null"
        :creating-seed="actions.creating.value?.seed ?? ''"
        :rename-path="actions.renamePath.value"
        :dragged-path="actions.draggedPath.value"
        @toggle="toggle"
        @select="onSelect"
        @contextmenu="onContextMenu"
        @create-commit="actions.onCreateCommit"
        @create-cancel="actions.onCreateCancel"
        @rename-commit="actions.onRenameCommit"
        @rename-cancel="actions.onRenameCancel"
        @dragstart="actions.draggedPath.value = $event"
        @dragend="actions.draggedPath.value = null"
        @drop="actions.onDrop"
      />
    </div>
    <div v-if="openError" class="hint err">{{ openError }}</div>
    <div v-if="tree.grouped.length" class="tree-legend">
      <span class="lg"><i class="lg-dot c-green"></i>定稿</span>
      <span class="lg"><i class="lg-dot c-yellow"></i>草稿</span>
      <span class="lg"><i class="lg-dot c-red"></i>待修</span>
      <span class="lg"><i class="lg-dot c-gray"></i>其他</span>
    </div>
    <ContextMenu
      v-if="!isNative"
      :visible="menuVisible"
      :x="menuX"
      :y="menuY"
      :items="menuItems"
      @select="onPopupSelect"
      @close="onPopupClose"
    />
    <ChapterMetaDialog
      :model-value="!!actions.metaEditing.value"
      :num="actions.metaEditing.value?.num ?? null"
      :标题="actions.metaEditing.value?.标题 ?? ''"
      :is-piece="actions.metaEditing.value?.isPiece ?? false"
      @update:model-value="(v: boolean) => { if (!v) actions.metaEditing.value = null }"
      @save="actions.onSaveMeta"
    />
  </div>
</template>

<style scoped>
.chapter-tree {
  padding: var(--size-4-1) 0 0;
  min-height: 100%;
  display: flex;
  flex-direction: column;
}
.hint {
  padding: 8px var(--size-4-3);
  font-size: var(--font-size-m);
  color: var(--text-faint);
}
.hint.err {
  color: var(--text-error);
}
.tree-list {
  padding: 0 var(--size-4-1);
  flex: 1;
  min-height: 0;
}
/* 色点图例（钉在文件树底部，单行） */
.tree-legend {
  display: flex;
  align-items: center;
  justify-content: center;
  flex-wrap: nowrap;
  gap: 12px;
  padding: 4px var(--size-4-2);
  font-size: var(--font-size-xxs);
  letter-spacing: 0.02em;
  color: var(--text-faint);
  border-top: 1px solid var(--background-modifier-border);
  background: var(--background-secondary);
  white-space: nowrap;
}
.lg {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}
.lg-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  flex-shrink: 0;
}
.lg-dot.c-green { background: var(--dv-good); }
.lg-dot.c-yellow { background: var(--text-warning); }
.lg-dot.c-red { background: var(--text-error); }
.lg-dot.c-gray { background: var(--text-faint); }
</style>
