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
  border: 1px solid var(--border);
  border-radius: 8px;
  overflow: hidden;
  margin-top: 12px;
}
.diff-toolbar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 8px 12px;
  background: var(--paper);
  border-bottom: 1px solid var(--border);
  font-size: 13px;
}
.diff-title {
  color: var(--text-2);
}
.diff-title .add {
  color: var(--ink-cyan);
}
.diff-title .del {
  color: var(--cinnabar);
}
.diff-actions {
  display: flex;
  gap: 8px;
}
.btn-accept {
  padding: 4px 12px;
  border: none;
  border-radius: 5px;
  background: var(--ink-cyan);
  color: var(--panel);
  font-size: 12px;
  cursor: pointer;
}
.btn-accept:disabled {
  opacity: 0.6;
  cursor: progress;
}
.btn-reject {
  padding: 4px 12px;
  border: 1px solid var(--border);
  border-radius: 5px;
  background: var(--panel);
  color: var(--text-2);
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
  color: var(--text-3);
  user-select: none;
}
.dl-same {
  background: var(--panel);
}
.dl-same .dl-text {
  color: var(--text-2);
}
.dl-add {
  background: var(--ok-bg);
}
.dl-add .dl-mark,
.dl-add .dl-text {
  color: var(--ink-cyan);
}
.dl-del {
  background: var(--danger-bg);
}
.dl-del .dl-mark,
.dl-del .dl-text {
  color: var(--cinnabar);
}
</style>
