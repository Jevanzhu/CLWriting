<script setup lang="ts">
import { ref, watch, nextTick } from 'vue'
import type { TreeNode } from '../../types/tree'

defineOptions({ name: 'ChapterTreeItem' })

const props = defineProps<{
  node: TreeNode
  depth: number
  expanded: Set<string>
  activePath: string | null
  /** inline 新建输入框：渲染在 renderDir 目录的子列表顶部。 */
  creatingDirPath: string | null
  creatingKind: 'chapter' | 'volume' | 'doc' | null
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
      :class="{ active: activePath === node.path, dragging: draggedPath === node.path }"
      :style="{ paddingLeft: `${depth * 14 + 8}px` }"
      @click="node.isDirectory ? emit('toggle', node.path) : emit('select', node)"
      @contextmenu.prevent="emit('contextmenu', node, $event.clientX, $event.clientY)"
      @dragover="node.isDirectory ? $event.preventDefault() : undefined"
      @drop="node.isDirectory ? (emit('drop', node.path), $event.preventDefault()) : undefined"
    >
      <span
        v-if="node.isDirectory"
        class="caret"
        draggable="true"
        @dragstart="emit('dragstart', node.path)"
        @dragend="emit('dragend')"
        @click.stop="emit('toggle', node.path)"
      >{{ isOpen() ? '▾' : '▸' }}</span>
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
    </div>

    <!-- 子节点 + 新建输入框 -->
    <template v-if="node.isDirectory && isOpen()">
      <div v-if="isCreatingHere()" class="tree-item" :style="{ paddingLeft: `${(depth + 1) * 14 + 8}px` }">
        <input
          ref="inp"
          v-model="inputVal"
          class="inline-input"
          :placeholder="creatingKind === 'volume' ? '卷名' : '名称'"
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
  gap: 4px;
  height: 26px;
  padding-right: 8px;
  font-size: 13px;
  color: var(--text-normal);
  cursor: pointer;
  border-radius: var(--radius-s);
  user-select: none;
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
.caret {
  width: 12px;
  color: var(--text-faint);
  font-size: 10px;
  flex-shrink: 0;
  cursor: grab;
}
.dot-slot {
  width: 12px;
  display: flex;
  justify-content: center;
  flex-shrink: 0;
}
.dot {
  width: 7px;
  height: 7px;
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
  font-size: 10px;
  color: var(--text-faint);
  flex-shrink: 0;
}
.inline-input {
  flex: 1;
  height: 20px;
  font-size: 13px;
  border: 1px solid var(--interactive-accent);
  border-radius: var(--radius-s);
  background: var(--background-primary);
  color: var(--text-normal);
  padding: 0 4px;
  outline: none;
}
</style>
