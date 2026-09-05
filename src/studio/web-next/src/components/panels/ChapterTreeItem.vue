<script setup lang="ts">
import { ref, watch, nextTick } from 'vue'
import { ChevronDown } from 'lucide-vue-next'
import type { TreeNode } from '../../types/tree'
import { useTreeStore } from '../../stores/tree'
import { isImeComposing } from '../../shared/ime'

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
  creatingKind: 'chapter' | 'chapter-outline' | 'volume-outline' | 'character' | 'item' | 'foreshadow' | 'volume' | 'doc' | null
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

// R37-31（三十七轮批E）：原生拖拽必须在 dragstart 内同步写 dataTransfer——Firefox 等
// 无 data 不启动拖拽（规范要求 drag data store 有项才进入拖拽会话）；同时命中区从
// 14px caret / 8px dot 扩到整行（常规行内无 input，重命名态整行被输入框替换、天然
// 不受影响，不破坏行内文本选择），path 同时作为 text/plain 供外部拖入
function onDragStart(e: DragEvent): void {
  e.dataTransfer?.setData('text/plain', props.node.path)
  emit('dragstart', props.node.path)
}

// 多参数事件转发（递归子项 → 父）：$event 仅首个参数，不能索引，故用方法
function forwardCtx(node: TreeNode, x: number, y: number): void {
  emit('contextmenu', node, x, y)
}
function forwardRename(path: string, value: string): void {
  emit('rename-commit', path, value)
}

const inputVal = ref('')
const inp = ref<HTMLInputElement | null>(null)

// R61-17（第六十一轮）：原 @keyup.enter 在 IME compositionend 之后触发（isComposing 已
// false），确认候选词的那次 Enter 与主动提交不可区分——统一改 keydown + 组合期守卫
// （重命名/新建的 Enter-then-blur 双发由 onRenameCommit/onCreateCommit 的态守卫防重）
function onRenameEnter(e: KeyboardEvent): void {
  if (isImeComposing(e)) return
  emit('rename-commit', props.node.path, inputVal.value)
}
function onRenameEsc(e: KeyboardEvent): void {
  // 组合期 Esc 归输入法（收候选框），不取消重命名（B-9 同判据）
  if (isImeComposing(e)) return
  emit('rename-cancel')
}
function onCreateEnter(e: KeyboardEvent): void {
  if (isImeComposing(e)) return
  emit('create-commit', inputVal.value)
}
function onCreateEsc(e: KeyboardEvent): void {
  if (isImeComposing(e)) return
  emit('create-cancel')
}

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
        @keydown.enter="onRenameEnter"
        @keydown.esc="onRenameEsc"
        @blur="emit('rename-commit', node.path, inputVal)"
      />
    </div>
    <!-- 常规行 -->
    <div
      v-else
      class="tree-item"
      :class="{ active: activePath === node.path, dragging: draggedPath === node.path, 'group-head': depth === 0 }"
      :style="{ paddingLeft: `${depth * 14 + 8}px` }"
      role="button"
      tabindex="0"
      draggable="true"
      @keydown.enter.prevent="node.isDirectory ? emit('toggle', node.path) : emit('select', node)"
      @keydown.space.prevent="node.isDirectory ? emit('toggle', node.path) : emit('select', node)"
      @click="node.isDirectory ? emit('toggle', node.path) : emit('select', node)"
      @contextmenu.prevent="emit('contextmenu', node, $event.clientX, $event.clientY)"
      @dragstart="onDragStart"
      @dragend="emit('dragend')"
      @dragover="node.isDirectory ? $event.preventDefault() : undefined"
      @drop="node.isDirectory ? (emit('drop', node.path), $event.preventDefault()) : undefined"
    >
      <ChevronDown
        v-if="node.isDirectory"
        :size="14"
        class="caret"
        :class="{ 'caret-closed': !isOpen() }"
        @click.stop="emit('toggle', node.path)"
      />
      <span v-else class="dot-slot">
        <span class="dot" :class="dotClass(node.status)"></span>
      </span>
      <span class="label">{{ node.name }}</span>
      <span v-if="node.status === 'published'" class="badge">·已发</span>
      <span
        v-if="tree.issuePaths.has(node.path)"
        class="issue-dot"
        data-tip="有校对红项或审稿驳回"
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
          @keydown.enter="onCreateEnter"
          @keydown.esc="onCreateEsc"
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
/* 顶级分组（写作/大纲/设定/布线）— 与章节行完全同权（2026-09-05 作者拍板：
 * 四分区为固定目录骨架（位置恒定 + 折叠箭头 + 缩进已足），字号/字重/颜色三线
 * 全部归零——去 600 加粗（反糊）、字号回 m 同号、色统一 --text-normal 同章行
 * （muted #555 对比章节行发灰发糊，作者反馈统一）；仅留上间距 + 字距极弱分组感） */
.tree-item.group-head {
  margin-top: 10px;
  font-size: var(--font-size-m);
  font-weight: normal;
  color: var(--text-normal);
  letter-spacing: 0.04em;
}
.tree-item.group-head:first-child {
  margin-top: 0;
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
  background: var(--dv-good);
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
/* 树红点（行尾，独立于行首六态 dot）。脉冲 3 圈后停在常亮：
   无限脉冲会驱动整窗持续出帧（闲置 CPU 复燃），状态常亮已足够传达。 */
.issue-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--text-error);
  flex-shrink: 0;
  animation: issue-pulse 1.6s ease-in-out 3;
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
