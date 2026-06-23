<script setup lang="ts">
/** 行级 diff 展示(+ 新 / - 旧 / 空格 同),接受/拒绝 */

interface DiffLine {
  type: 'same' | 'add' | 'del'
  text: string
}

defineProps<{ diff: DiffLine[]; applying?: boolean }>()
const emit = defineEmits<{ accept: []; reject: [] }>()
</script>

<template>
  <div class="diff-view">
    <div class="diff-toolbar">
      <span class="diff-title">改写预览(<span class="add">+ 新</span> / <span class="del">- 旧</span>)</span>
      <span class="diff-actions">
        <button class="btn-accept" :disabled="applying" @click="emit('accept')">{{ applying ? '应用中…' : '✓ 接受落盘' }}</button>
        <button class="btn-reject" :disabled="applying" @click="emit('reject')">✗ 拒绝</button>
      </span>
    </div>
    <div class="diff-body">
      <div v-for="(l, i) in diff" :key="i" :class="`dl dl-${l.type}`">
        <span class="dl-mark">{{ l.type === 'add' ? '+' : l.type === 'del' ? '-' : ' ' }}</span>
        <span class="dl-text">{{ l.text || ' ' }}</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.diff-view {
  border: 1px solid #e5e7eb;
  border-radius: 8px;
  overflow: hidden;
  margin-top: 12px;
}
.diff-toolbar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 8px 12px;
  background: #f9fafb;
  border-bottom: 1px solid #e5e7eb;
  font-size: 13px;
}
.diff-title {
  color: #6b7280;
}
.diff-title .add {
  color: #059669;
}
.diff-title .del {
  color: #dc2626;
}
.diff-actions {
  display: flex;
  gap: 8px;
}
.btn-accept {
  padding: 4px 12px;
  border: none;
  border-radius: 5px;
  background: #059669;
  color: #fff;
  font-size: 12px;
  cursor: pointer;
}
.btn-accept:disabled {
  opacity: 0.6;
  cursor: progress;
}
.btn-reject {
  padding: 4px 12px;
  border: 1px solid #d1d5db;
  border-radius: 5px;
  background: #fff;
  color: #6b7280;
  font-size: 12px;
  cursor: pointer;
}
.btn-reject:disabled {
  opacity: 0.6;
}
.diff-body {
  max-height: 420px;
  overflow-y: auto;
  font-family: ui-monospace, monospace;
  font-size: 13px;
  line-height: 1.5;
}
.dl {
  display: grid;
  grid-template-columns: 20px 1fr;
  gap: 4px;
  padding: 0 8px;
  white-space: pre-wrap;
  word-break: break-word;
}
.dl-mark {
  color: #9ca3af;
  user-select: none;
}
.dl-same {
  background: #fff;
}
.dl-same .dl-text {
  color: #4b5563;
}
.dl-add {
  background: #ecfdf5;
}
.dl-add .dl-mark,
.dl-add .dl-text {
  color: #065f46;
}
.dl-del {
  background: #fef2f2;
}
.dl-del .dl-mark,
.dl-del .dl-text {
  color: #991b1b;
}
</style>
