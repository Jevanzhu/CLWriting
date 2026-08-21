<script setup lang="ts">
// 上下文速查面板：设定区文件速查（点开开 tab / 插入正文光标）。
import { computed } from 'vue'
import { CornerDownLeft } from 'lucide-vue-next'
import { useTreeStore } from '../../stores/tree'
import { useDocStore } from '../../stores/doc'
import { useWorkspaceStore } from '../../stores/workspace'
import { useUiStore } from '../../stores/ui'
import { friendlyError } from '../../shared/error'
import type { TreeNode } from '../../types/tree'

defineProps<{ bookName: string }>()
const tree = useTreeStore()
const doc = useDocStore()
const ws = useWorkspaceStore()
const ui = useUiStore()

// 设定区叶子（递归 设定 组）
const settings = computed<TreeNode[]>(() => {
  const out: TreeNode[] = []
  const shezhi = tree.grouped.find((n) => n.path === '设定')
  const walk = (ns: TreeNode[]): void => {
    for (const n of ns) {
      if (!n.isDirectory) out.push(n)
      else if (n.children.length) walk(n.children)
    }
  }
  if (shezhi) walk(shezhi.children)
  return out
})

async function open(node: TreeNode): Promise<void> {
  if (!node.docId) return
  try {
    await doc.open(node)
    ws.openTab(node.docId)
  } catch (e) {
    // P5-前端（第七轮）：静默吞错收敛（对齐 ForeshadowPanel）
    ui.toast(friendlyError(e), 'error')
  }
}

/** 插入文档名到正文光标（命令管道 → EditorView → CmHost）；无活动文档时跳过。 */
function onInsert(text: string): void {
  if (!ws.activeDocId) return
  ws.requestInsert(text)
}
</script>

<template>
  <div class="ctx-panel">
    <div class="side-title">设定速查</div>
    <div v-if="!settings.length" class="side-hint">无设定文档</div>
    <div v-else class="setting-list">
      <div
        v-for="s in settings"
        :key="s.docId"
        class="setting-item"
        @click="open(s)"
      >
        <span class="setting-name">{{ s.name }}</span>
        <button
          class="insert-btn"
          data-tip="插入到正文光标处"
          @click.stop="onInsert(s.name)"
        >
          <CornerDownLeft :size="13" />
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.ctx-panel {
  display: flex;
  flex-direction: column;
  gap: var(--size-4-2);
}
.side-title {
  font-size: var(--font-size-xs);
  font-weight: 600;
  color: var(--text-faint);
  text-transform: uppercase;
  letter-spacing: 0.05em;
}
.side-hint {
  font-size: var(--font-size-s);
  color: var(--text-faint);
}
.setting-list {
  display: flex;
  flex-direction: column;
  gap: 1px;
}
.setting-item {
  font-size: var(--font-size-s);
  color: var(--text-muted);
  padding: 5px var(--size-4-2);
  border-radius: var(--radius-s);
  cursor: pointer;
  display: flex;
  align-items: center;
  gap: 4px;
}
.setting-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.insert-btn {
  flex-shrink: 0;
  display: flex;
  color: var(--text-faint);
  background: none;
  border: none;
  cursor: pointer;
  padding: 0;
}
.insert-btn:hover {
  color: var(--text-accent);
}
.setting-item:hover {
  background: var(--background-modifier-hover);
  color: var(--text-normal);
}
</style>
