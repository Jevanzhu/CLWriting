<script setup lang="ts">
// 关闭 dirty tab 三选确认（细案 T1.3：保存/放弃/取消）。由 pendingCloseTabId 驱动。
import { computed } from 'vue'
import { useWorkspaceStore } from '../../stores/workspace'
import { useDocStore } from '../../stores/doc'
import { useTreeStore } from '../../stores/tree'

const ws = useWorkspaceStore()
const doc = useDocStore()
const tree = useTreeStore()

const docName = computed(() => {
  const id = ws.pendingCloseTabId
  if (!id) return ''
  const tab = ws.tabs.find((t) => t.id === id)
  if (!tab) return ''
  return doc.get(tab.docId)?.name ?? tree.byDocId.get(tab.docId)?.name ?? '未命名'
})
</script>

<template>
  <div v-if="ws.pendingCloseTabId" class="modal-mask" @click.self="ws.cancelClose">
    <div class="modal" role="dialog" aria-modal="true">
      <div class="modal-title">未保存的更改</div>
      <div class="modal-body">「{{ docName }}」有未保存的内容，关闭前是否保存？</div>
      <div class="modal-actions">
        <button class="btn" @click="ws.cancelClose">取消</button>
        <button class="btn" @click="ws.confirmDiscard">放弃</button>
        <button class="btn primary" @click="ws.confirmSaveAndClose">保存</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.modal-mask {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.35);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 100;
}
.modal {
  width: 360px;
  background: var(--background-primary);
  border: 1px solid var(--background-modifier-border);
  border-radius: var(--radius-l);
  padding: var(--size-4-4);
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.2);
}
.modal-title {
  font-size: 15px;
  font-weight: 600;
  color: var(--text-normal);
  margin-bottom: var(--size-4-2);
}
.modal-body {
  font-size: 13px;
  color: var(--text-muted);
  line-height: 1.6;
  margin-bottom: var(--size-4-4);
}
.modal-actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--size-4-2);
}
.btn {
  padding: 6px 14px;
  font-size: 13px;
  border: 1px solid var(--background-modifier-border);
  border-radius: var(--radius-s);
  background: var(--background-primary);
  color: var(--text-normal);
  cursor: pointer;
}
.btn:hover {
  background: var(--background-modifier-hover);
}
.btn.primary {
  background: var(--interactive-accent);
  border-color: var(--interactive-accent);
  color: var(--text-on-accent);
}
.btn.primary:hover {
  background: var(--interactive-accent-hover);
}
</style>
