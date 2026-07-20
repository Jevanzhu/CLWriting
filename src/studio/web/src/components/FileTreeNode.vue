<script setup lang="ts">
// 文件树递归节点（W2A §10.1）。
// 目录：caret 折叠头，点击 toggle；叶子：.dot 八态圆点 + 名称，点击 select。
// 缩进 depth × 18px；published 叶子名后缀「·已发」（§5.1，不新增色 token）。
import { computed } from 'vue'

/** 树节点（镜像后端 TreeNode，src/document/tree.ts）。 */
interface TreeNode {
  path: string
  name: string
  isDirectory: boolean
  role: string
  children: TreeNode[]
  docId?: string
  status?: string
  volumeOutlinePath?: string
}

const props = defineProps<{
  node: TreeNode
  depth: number
  /** 展开的目录 path 集合。 */
  expanded: Set<string>
  /** 当前选中文件 path（route.query.file）。 */
  current: string
}>()

const emit = defineEmits<{
  toggle: [path: string]
  select: [path: string]
}>()

defineOptions({ name: 'FileTreeNode' })

const isOpen = computed(() => props.expanded.has(props.node.path))
const padLeft = computed(() => `${props.depth * 18 + 10}px`)

/** 八态 → 圆点色（§5.1）：published 合并 green；目录无圆点（不挂 status）。 */
function dotClass(status?: string): string {
  switch (status) {
    case 'final':
    case 'published':
      return 'green'
    case 'revision':
      return 'red'
    case 'draft':
      return 'yellow'
    default: // archived / idea
      return 'gray'
  }
}

/** 展示名：published 叶子加「·已发」后缀区分（green 已与 final 合并，靠后缀辨身份）。 */
function displayName(node: TreeNode): string {
  return node.status === 'published' ? `${node.name} ·已发` : node.name
}

function onClick(): void {
  if (props.node.isDirectory) emit('toggle', props.node.path)
  else emit('select', props.node.path)
}
</script>

<template>
  <div>
    <div
      class="tnode"
      :class="[node.isDirectory ? 'dir' : 'leaf', { active: !node.isDirectory && node.path === current }]"
      :style="{ paddingLeft: padLeft }"
      @click="onClick"
    >
      <span v-if="node.isDirectory" class="caret">{{ isOpen ? '▾' : '▸' }}</span>
      <span v-else class="dot-slot"><span class="dot" :class="dotClass(node.status)"></span></span>
      <span class="name">{{ node.isDirectory ? node.name : displayName(node) }}</span>
    </div>
    <template v-if="node.isDirectory && isOpen">
      <FileTreeNode
        v-for="child in node.children"
        :key="child.path"
        :node="child"
        :depth="depth + 1"
        :expanded="expanded"
        :current="current"
        @toggle="(p) => emit('toggle', p)"
        @select="(p) => emit('select', p)"
      />
    </template>
  </div>
</template>

<style scoped>
/* 行样式对齐 .binder-item（margin 1px 4px + padding 6px + radius 5px），
   选中/hover 灰色长条与书籍栏完全一致；动态 paddingLeft 支持任意深度递归缩进。 */
.tnode {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 6px 10px;
  font-size: 13px;
  color: var(--text-2);
  cursor: pointer;
  border-radius: 5px;
  user-select: none;
  transition: background 0.12s, color 0.12s;
  position: relative;
  margin: 1px 4px;
}
.tnode:hover {
  background: var(--flat-hover);
  color: var(--ink);
}
.tnode.dir {
  font-weight: 600;
}
.tnode.leaf {
  font-weight: 500;
}
.tnode.active {
  color: var(--ink);
  background: var(--flat-active);
  font-weight: 600;
}
.tnode.active::before {
  content: '';
  position: absolute;
  left: 0;
  top: 5px;
  bottom: 5px;
  width: 2px;
  background: var(--ink-cyan);
  border-radius: 1px;
}
.caret {
  width: 10px;
  color: var(--text-3);
  font-size: 9px;
  flex-shrink: 0;
  transition: transform 0.15s;
}
/* dot 占位与 caret 等宽（10px），dot 7px 居中，行间对齐 */
.dot-slot {
  width: 10px;
  flex-shrink: 0;
  display: flex;
  justify-content: center;
}
.name {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
</style>
