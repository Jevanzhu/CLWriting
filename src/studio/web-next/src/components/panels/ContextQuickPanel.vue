<script setup lang="ts">
// 上下文速查面板（细案 T2.3）：设定区文件速查（点开开 tab）+ AI 辅助位预留置灰。
import { computed } from 'vue'
import { useTreeStore } from '../../stores/tree'
import { useDocStore } from '../../stores/doc'
import { useWorkspaceStore } from '../../stores/workspace'
import { serverOnline } from '../../composables/useHeartbeat'
import type { TreeNode } from '../../types/tree'

defineProps<{ bookName: string }>()
const tree = useTreeStore()
const doc = useDocStore()
const ws = useWorkspaceStore()

// 设定区叶子（递归 定稿/设定 组）
const settings = computed<TreeNode[]>(() => {
  const out: TreeNode[] = []
  const shezhi = tree.grouped.find((n) => n.path === '定稿/设定')
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
  } catch {
    /* 打开失败静默 */
  }
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
        {{ s.name }}
      </div>
    </div>
    <div class="ai-slot" :class="{ disabled: !serverOnline }">
      <div class="side-title">AI 辅助</div>
      <div class="side-hint">{{ serverOnline ? '待 G4 接入' : 'API 未连接' }}</div>
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
  font-size: 11px;
  font-weight: 600;
  color: var(--text-faint);
  text-transform: uppercase;
  letter-spacing: 0.05em;
}
.side-hint {
  font-size: 12px;
  color: var(--text-faint);
}
.setting-list {
  display: flex;
  flex-direction: column;
  gap: 1px;
}
.setting-item {
  font-size: 12px;
  color: var(--text-muted);
  padding: 5px var(--size-4-2);
  border-radius: var(--radius-s);
  cursor: pointer;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.setting-item:hover {
  background: var(--background-modifier-hover);
  color: var(--text-normal);
}
.ai-slot {
  margin-top: var(--size-4-2);
  padding-top: var(--size-4-2);
  border-top: 1px solid var(--background-modifier-border);
}
.ai-slot.disabled .side-hint {
  color: var(--text-faint);
  opacity: 0.6;
}
</style>
