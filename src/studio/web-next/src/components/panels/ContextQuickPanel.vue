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
  // 家族守卫（ChapterTreePanel 同款）——await 前快照书名，
  // doc.open 在途切书后不得把旧书文档开进新书工作区（旧书 docId 可写入新书 activeDocId）
  const bookAtClick = ws.bookName
  try {
    await doc.open(node)
    if (ws.bookName !== bookAtClick) return
    ws.openTab(node.docId)
  } catch (e) {
    // -前端：静默吞错收敛（对齐 ForeshadowPanel）
    ui.toast(friendlyError(e), 'error')
  }
}

/** 插入文档名到正文光标（命令管道 → EditorView → CmHost）。 */
function onInsert(text: string): void {
  // 无活动文档时给反馈——此前静默 return，点击毫无响应像功能坏了
  if (!ws.activeDocId) {
    ui.toast('没有打开中的文档——先点开一章或设定文件，再插入', 'info')
    return
  }
  // 0918修复批（F002）：非编辑器视图时 EditorView 未挂载（Book.vue
  // v-if="activeView === 'editor'"），pendingInsert 入槽无人即时消费且点击零反馈。
  // 照常 requestInsert 入槽：EditorView 挂载时 onMounted 补消费（272）+ doc 落位后
  // nextTick 补消费（249）会补插；补挂起反馈让点击不再像坏了
  if (ws.activeView !== 'editor') {
    ui.toast('已挂起：回到编辑器视图后自动插入', 'info')
  }
  ws.requestInsert(text)
}
</script>

<template>
  <div class="ctx-panel">
    <div class="side-title">设定速查</div>
    <div v-if="!settings.length" class="side-hint">无设定文档</div>
    <div v-else class="setting-list">
      <!-- #12：docId 可空（未登记清单的设定文件，tree.ts legacyId 兜底前可缺），
           多条空值同作 key 会撞 Vue 重复键——回落稳定唯一的 path 兜底（path 全树唯一） -->
      <div
        v-for="s in settings"
        :key="s.docId ?? s.path"
        class="setting-item"
        role="button"
        tabindex="0"
        @keydown.enter.prevent="open(s)"
        @keydown.space.prevent="open(s)"
        @click="open(s)"
      >
        <span class="setting-name">{{ s.name }}</span>
        <button class="insert-btn" data-tip="插入到正文光标处" @click.stop="onInsert(s.name)">
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
