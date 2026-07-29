<script setup lang="ts">
import { ref, watch, nextTick } from 'vue'
import { ChevronDown } from 'lucide-vue-next'
import type { TreeNode } from '../../types/tree'
import { useTreeStore } from '../../stores/tree'

defineOptions({ name: 'ChapterTreeItem' })

// T9b：读全局 issue 红点集合（冒泡后含叶子自身 + 子树命中的目录），行尾渲染。
const tree = useTreeStore()

const props = defineProps<{
  node: TreeNode
  depth: number
  expanded: Set<string>
  activePath: string | null
  /** inline 新建输入框：渲染在 renderDir 目录的子列表顶部。 */
  creatingDirPath: string | null
  creatingKind: 'chapter' | 'chapter-outline' | 'volume-outline' | 'character' | 'item' | 'volume' | 'doc' | null
  creatingSeed: string
  /** inline 重命名输入框：path 命中则替代 label。 */
  renamePath: string | null
  /** 当前拖拽源 path（视觉半透明）。 */
  draggedPath: string | null
}>()
const emit = defineEmits<{
  toggle: [path: string]
  select: [node: TreeNode]
  contextmenu: [node: TreeNode, x: number, y: number]
  'create-commit': [value: string]
  'create-cancel': []
  'rename-commit': [path: string, value: string]
  'rename-cancel': []
  dragstart: [path: string]
  dragend: []
  drop: [targetPath: string]
}>()

// 六态角标（细案 §3）：final·published 绿 / revision 红 / draft 黄 / 其余灰
function dotClass(status?: string): string {
  switch (status) {
    case 'final':
    case 'published':
      return 'dot-green'
    case 'revision':
      return 'dot-red'
    case 'draft':
      return 'dot-yellow'
    default:
      return 'dot-gray'
  }
}

const isOpen = () => props.expanded.has(props.node.path)
const isCreatingHere = () =>
  props.creatingDirPath === props.node.path && props.node.isDirectory && isOpen()
const isRenaming = () => props.renamePath === props.node.path

// 多参数事件转发（递归子项 → 父）：$event 仅首个参数，不能索引，故用方法
function forwardCtx(node: TreeNode, x: number, y: number): void {
  emit('contextmenu', node, x, y)
}
function forwardRename(path: string, value: string): void {
  emit('rename-commit', path, value)
}

const inputVal = ref('')
const inp = ref<HTMLInputElement | null>(null)

// 进入新建/重命名态：初始化值 + 聚焦
watch(
  () => [props.creatingDirPath, props.renamePath],
  async () => {
    if (isCreatingHere()) {
      inputVal.value = props.creatingSeed
      await nextTick()
      inp.value?.focus()
    } else if (isRenaming()) {
      inputVal.value = props.node.name
      await nextTick()
      inp.value?.focus()
    }
  },
  { immediate: true },
)
</script>

<template>
  <div>
    <!-- 重命名态：输入框替代整行 -->
    <div v-if="isRenaming()" class="tree-item" :style="{ paddingLeft: `${depth * 14 + 8}px` }">
      <input
        ref="inp"
        v-model="inputVal"
        class="inline-input"
        @click.stop
        @keyup.enter="emit('rename-commit', node.path, inputVal)"
        @keyup.esc="emit('rename-cancel')"
        @blur="emit('rename-commit', node.path, inputVal)"
      />
    </div>
    <!-- 常规行 -->
    <div
      v-else
      class="tree-item"
      :class="{ active: activePath === node.path, dragging: draggedPath === node.path, 'group-head': depth === 0 }"
      :style="{ paddingLeft: `${depth * 14 + 8}px` }"
      @click="node.isDirectory ? emit('toggle', node.path) : emit('select', node)"
      @contextmenu.prevent="emit('contextmenu', node, $event.clientX, $event.clientY)"
      @dragover="node.isDirectory ? $event.preventDefault() : undefined"
      @drop="node.isDirectory ? (emit('drop', node.path), $event.preventDefault()) : undefined"
    >
      <ChevronDown
        v-if="node.isDirectory"
        :size="14"
        class="caret"
        :class="{ 'caret-closed': !isOpen() }"
        draggable="true"
        @dragstart="emit('dragstart', node.path)"
        @dragend="emit('dragend')"
        @click.stop="emit('toggle', node.path)"
      />
      <span v-else class="dot-slot">
        <span
          class="dot"
          :class="dotClass(node.status)"
          draggable="true"
          @dragstart="emit('dragstart', node.path)"
          @dragend="emit('dragend')"
        ></span>
      </span>
      <span class="label">{{ node.name }}</span>
      <span v-if="node.status === 'published'" class="badge">·已发</span>
      <span
        v-if="tree.issuePaths.has(node.path)"
        class="issue-dot"
        data-tip="有机检红项或审稿驳回"
      ></span>
    </div>

    <!-- 子节点 + 新建输入框 -->
    <template v-if="node.isDirectory && isOpen()">
      <div v-if="isCreatingHere()" class="tree-item" :style="{ paddingLeft: `${(depth + 1) * 14 + 8}px` }">
        <input
          ref="inp"
          v-model="inputVal"
          class="inline-input"
          :placeholder="creatingKind === 'volume' ? '卷名' : creatingKind === 'character' ? '姓名' : '名称'"
          @click.stop
          @keyup.enter="emit('create-commit', inputVal)"
          @keyup.esc="emit('create-cancel')"
          @blur="emit('create-commit', inputVal)"
        />
      </div>
      <ChapterTreeItem
        v-for="c in node.children"
        :key="c.path"
        :node="c"
        :depth="depth + 1"
        :expanded="expanded"
        :active-path="activePath"
        :creating-dir-path="creatingDirPath"
        :creating-kind="creatingKind"
        :creating-seed="creatingSeed"
        :rename-path="renamePath"
        :dragged-path="draggedPath"
        @toggle="emit('toggle', $event)"
        @select="emit('select', $event)"
        @contextmenu="forwardCtx"
        @create-commit="emit('create-commit', $event)"
        @create-cancel="emit('create-cancel')"
        @rename-commit="forwardRename"
        @rename-cancel="emit('rename-cancel')"
        @dragstart="emit('dragstart', $event)"
        @dragend="emit('dragend')"
        @drop="emit('drop', $event)"
      />
    </template>
  </div>
</template>

<style scoped>
.tree-item {
  display: flex;
  align-items: center;
  gap: 5px;
  height: 27px;
  padding-right: 8px;
  font-size: var(--font-size-m);
  color: var(--text-normal);
  cursor: pointer;
  border-radius: var(--radius-s);
  user-select: none;
  transition: background var(--dur-fast) var(--ease-out);
}
.tree-item:hover {
  background: var(--background-modifier-hover);
}
.tree-item.active {
  background: var(--background-modifier-active-hover);
}
.tree-item.dragging {
  opacity: 0.4;
}
/* 顶级分组（写作/大纲/设定）— 与普通行完全统一，仅保留分组间隔 */
.tree-item.group-head {
  margin-top: 2px;
}
/* Lucide caret：折叠时旋转 -90°，展开时朝下，带过渡 */
.caret {
  color: var(--text-faint);
  flex-shrink: 0;
  cursor: grab;
  transition: transform var(--dur-fast) var(--ease-out);
}
.caret.caret-closed {
  transform: rotate(-90deg);
}
.dot-slot {
  width: 14px;
  display: flex;
  justify-content: center;
  flex-shrink: 0;
}
.dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  cursor: grab;
}
.dot-green {
  background: var(--text-success);
}
.dot-red {
  background: var(--text-error);
}
.dot-yellow {
  background: var(--text-warning);
}
.dot-gray {
  background: var(--text-faint);
}
.label {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.badge {
  font-size: var(--font-size-xxs);
  color: var(--text-faint);
  flex-shrink: 0;
}
/* 树红点（行尾，独立于行首六态 dot） */
.issue-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--text-error, #e05d5d);
  flex-shrink: 0;
  animation: issue-pulse 1.6s ease-in-out infinite;
}
@keyframes issue-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.35; }
}
.inline-input {
  flex: 1;
  height: 22px;
  font-size: var(--font-size-m);
  border: 1px solid var(--interactive-accent);
  border-radius: var(--radius-s);
  background: var(--background-primary);
  color: var(--text-normal);
  padding: 0 4px;
  outline: none;
}
</style>
