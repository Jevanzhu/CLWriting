<script setup lang="ts">
// 文件树递归节点（W2A §10.1）+ 拖拽移动（T8 §10.2，仅 inside 落点）。
// 叶子文档 draggable；目录接收 drop（inside = moveDocument toDir）；跨 role/区禁（canDrop）。
// 排序落点（before/after）不做——CLighting 章号定序 + 无 order 字段，拖排无后端。
import { computed, ref } from 'vue'

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
  /** 当前拖拽源 path（null = 未拖）。 */
  draggedPath: string | null
}>()

const emit = defineEmits<{
  toggle: [path: string]
  select: [path: string]
  dragstart: [path: string]
  dragend: []
  drop: [sourcePath: string, targetPath: string]
}>()

defineOptions({ name: 'FileTreeNode' })

const isOpen = computed(() => props.expanded.has(props.node.path))
const padLeft = computed(() => `${props.depth * 18 + 10}px`)
/** 目录接收 dragover 时的视觉态（高亮 inside 落点）。 */
const isDragOver = ref(false)

/** 八态 → 圆点色（§5.1）：published 合并 green；目录无圆点。 */
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

/** 递归计叶子数（目录次要信息用）。 */
function countLeaves(ns: TreeNode[]): number {
  let c = 0
  for (const n of ns) c += n.isDirectory ? countLeaves(n.children) : 1
  return c
}

/** 定稿/正文/<卷> → <卷>（卷目录名，直接子级）。 */
function matchVolumeName(path: string): string | null {
  const prefix = '定稿/正文/'
  if (!path.startsWith(prefix)) return null
  const rest = path.slice(prefix.length)
  return rest && !rest.includes('/') ? rest : null
}

/** 目录次要信息（T9a §17 决策②，纯扫描计数）：卷「✓卷纲·N章」/ 大纲子目录「N 条」。
 *  无匹配 → null（不显示）。 */
function dirMeta(node: TreeNode): string | null {
  if (!node.isDirectory) return null
  if (matchVolumeName(node.path)) {
    return `${node.volumeOutlinePath ? '✓卷纲 · ' : ''}${countLeaves(node.children)}章`
  }
  // 大纲子目录（大纲/X，直接子级）→ 「N 条」
  if (node.path.startsWith('大纲/')) {
    const rest = node.path.slice('大纲/'.length)
    if (rest && !rest.includes('/')) return `${countLeaves(node.children)} 条`
  }
  return null
}

/** 文档所属区（同区可移动，跨区/跨 role 禁）：正文 / 大纲 / 设定 / 工作区。 */
function zoneOf(p: string): string | null {
  if (p === '定稿/正文' || p.startsWith('定稿/正文/')) return 'body'
  if (p === '大纲' || p.startsWith('大纲/')) return 'outline'
  if (p === '定稿/设定' || p.startsWith('定稿/设定/')) return 'setting'
  if (p.startsWith('工作区/')) return 'workdir'
  return null
}

/** canDrop：叶子拖进目录 + 同区 + 非自身子树（T8 §10.2，仅 inside 落点）。 */
function canDropHere(): boolean {
  if (!props.draggedPath || !props.node.isDirectory) return false
  if (props.draggedPath === props.node.path) return false
  // 源是目标祖先 → 禁（防循环；叶子无子，保险）
  if (props.node.path.startsWith(props.draggedPath + '/')) return false
  const sz = zoneOf(props.draggedPath)
  return sz !== null && sz === zoneOf(props.node.path)
}

function onClick(): void {
  if (props.node.isDirectory) emit('toggle', props.node.path)
  else emit('select', props.node.path)
}

function onDragStart(e: DragEvent): void {
  if (props.node.isDirectory) return
  if (e.dataTransfer) {
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('text/plain', props.node.path) // Firefox 需 setData 才触发 drag
  }
  emit('dragstart', props.node.path)
}

function onDragEnd(): void {
  emit('dragend')
}

function onDragOver(e: DragEvent): void {
  if (!canDropHere()) return // 不 preventDefault → 禁止 drop（光标显示禁止）
  e.preventDefault()
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'move'
  isDragOver.value = true
}

function onDragLeave(): void {
  isDragOver.value = false
}

function onDrop(e: DragEvent): void {
  e.preventDefault()
  isDragOver.value = false
  if (canDropHere() && props.draggedPath) {
    emit('drop', props.draggedPath, props.node.path)
  }
}
</script>

<template>
  <div>
    <div
      class="tnode"
      :class="[
        node.isDirectory ? 'dir' : 'leaf',
        { active: !node.isDirectory && node.path === current, 'drag-over': isDragOver },
      ]"
      :style="{ paddingLeft: padLeft }"
      :draggable="!node.isDirectory"
      @click="onClick"
      @dragstart="onDragStart"
      @dragend="onDragEnd"
      @dragover="onDragOver"
      @dragleave="onDragLeave"
      @drop="onDrop"
    >
      <span v-if="node.isDirectory" class="caret">{{ isOpen ? '▾' : '▸' }}</span>
      <span v-else class="dot-slot"><span class="dot" :class="dotClass(node.status)"></span></span>
      <span class="name">{{ node.isDirectory ? node.name : displayName(node) }}</span>
      <span v-if="dirMeta(node)" class="tn-tag">{{ dirMeta(node) }}</span>
    </div>
    <template v-if="node.isDirectory && isOpen">
      <FileTreeNode
        v-for="child in node.children"
        :key="child.path"
        :node="child"
        :depth="depth + 1"
        :expanded="expanded"
        :current="current"
        :dragged-path="draggedPath"
        @toggle="(p) => emit('toggle', p)"
        @select="(p) => emit('select', p)"
        @dragstart="(p) => emit('dragstart', p)"
        @dragend="emit('dragend')"
        @drop="(s, t) => emit('drop', s, t)"
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
/* T8 拖拽 inside 落点高亮（目录接收 drop 时） */
.tnode.drag-over {
  background: var(--cyan-10);
  outline: 1px dashed var(--ink-cyan);
  outline-offset: -1px;
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
  flex: 1;
  min-width: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
/* T9a 目录次要信息（右侧小灰字） */
.tn-tag {
  margin-left: 6px;
  font-size: 10px;
  color: var(--text-3);
  font-weight: 400;
  flex-shrink: 0;
}
</style>
