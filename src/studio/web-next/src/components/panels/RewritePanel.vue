<script setup lang="ts">
// 改写面板（M12 块2 B2.2/B2.3）：输入指令 → 改写整章 → DiffView → 接受进 buffer / 拒绝。
// 接受 = patch(docId, rewritten) 写编辑器（dirty，⌘S 保存）；AI 永不直接落盘。
// 选区改写（local）后置——需 CmHost 暴露 getSelection；当前 whole 整章。
import { computed, ref } from 'vue'
import { Wand2, RefreshCw, Check, X, AlertCircle, Plus, Minus } from 'lucide-vue-next'
import { useRewriteStore } from '../../stores/rewrite'
import { useWorkspaceStore } from '../../stores/workspace'
import { useTreeStore } from '../../stores/tree'
import { useUiStore } from '../../stores/ui'
import { formKindOf, isBodyKind } from '../../shared/words'

const props = defineProps<{ bookName: string }>()
const rewrite = useRewriteStore()
const ws = useWorkspaceStore()
const tree = useTreeStore()
const ui = useUiStore()

const docId = computed(() => ws.activeDocId)
const node = computed(() => (docId.value ? tree.byDocId.get(docId.value) : undefined))
const isReviewable = computed(() => {
  if (!node.value) return false
  if (formKindOf(node.value.path) !== null) return true
  return isBodyKind(node.value.path)
})
const aiOff = computed(() => ui.aiAvailable === false)

const instruction = ref('')

const diffStats = computed(() => {
  const d = rewrite.result?.diff ?? []
  return { add: d.filter((x) => x.type === 'add').length, del: d.filter((x) => x.type === 'del').length }
})

async function runRewrite(): Promise<void> {
  if (!docId.value || !instruction.value.trim()) return
  // 读编辑器选区：非空→local 选段改写；空→whole 整章（后端按 selection 判模式）
  const sel = ws.editorGetSelection?.() ?? ''
  await rewrite.run(props.bookName, docId.value, instruction.value.trim(), sel)
}

function accept(): void {
  if (docId.value) rewrite.accept(props.bookName, docId.value)
  instruction.value = ''
}
</script>

<template>
  <section class="rewrite-panel">
    <div class="rw-title-row">
      <Wand2 :size="14" />
      <span class="rw-title">改写</span>
    </div>

    <div v-if="!isReviewable" class="rw-hint">改写仅适用于正文 / 草稿文档。</div>

    <template v-else>
      <textarea
        v-model="instruction"
        class="rw-input"
        placeholder="改写指令（如：让开头更紧张、压缩对话…）"
        rows="2"
        :disabled="aiOff || rewrite.loading"
      />

      <button
        class="rw-run-btn"
        :disabled="!instruction.trim() || aiOff || rewrite.loading || !!rewrite.result"
        @click="runRewrite"
      >
        <RefreshCw :size="13" :class="{ spin: rewrite.loading }" />
        <span>{{ rewrite.loading ? '改写中…' : '改写' }}</span>
      </button>
      <div class="rw-hint rw-hint--mode">选中段落 → 改写选段；无选区 → 整章改写。</div>

      <div v-if="aiOff" class="rw-hint">AI 不可达，改写置灰。</div>

      <div v-else-if="rewrite.error" class="rw-error">
        <AlertCircle :size="14" />
        <span>{{ rewrite.error }}</span>
      </div>

      <template v-else-if="rewrite.result">
        <div class="rw-diff-head">
          <span class="rw-mode">{{ rewrite.result.mode === 'whole' ? '整章' : '选段' }}改写</span>
          <span class="rw-stats">
            <span class="stat-add">+{{ diffStats.add }}</span>
            <span class="stat-del">-{{ diffStats.del }}</span>
          </span>
        </div>
        <div class="rw-diff">
          <div
            v-for="(line, i) in rewrite.result.diff"
            :key="i"
            class="diff-line"
            :class="'diff-' + line.type"
          >
            <Plus v-if="line.type === 'add'" :size="11" class="diff-mark" />
            <Minus v-else-if="line.type === 'del'" :size="11" class="diff-mark" />
            <span v-else class="diff-mark diff-mark--same" />
            <span class="diff-text">{{ line.text || ' ' }}</span>
          </div>
        </div>
        <div class="rw-actions">
          <button class="rw-accept" @click="accept">
            <Check :size="13" />
            <span>接受（进编辑器）</span>
          </button>
          <button class="rw-reject" @click="rewrite.reject">
            <X :size="13" />
            <span>放弃</span>
          </button>
        </div>
      </template>
    </template>
  </section>
</template>

<style scoped>
.rewrite-panel {
  display: flex;
  flex-direction: column;
  gap: var(--size-4-2);
  padding-top: var(--size-4-3);
  border-top: 1px solid var(--background-modifier-border);
}
.rw-title-row {
  display: inline-flex;
  align-items: center;
  gap: var(--size-4-1);
  color: var(--text-muted);
  font-size: var(--font-size-xs);
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
}
.rw-input {
  width: 100%;
  resize: vertical;
  border: 1px solid var(--background-modifier-border);
  border-radius: var(--radius-s);
  background: var(--background-primary);
  color: var(--text-normal);
  font-size: var(--font-size-s);
  padding: 6px 8px;
  font-family: inherit;
}
.rw-input:focus {
  outline: none;
  border-color: var(--interactive-accent);
}
.rw-run-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 4px 10px;
  border: 1px solid var(--background-modifier-border);
  border-radius: var(--radius-s);
  background: var(--interactive-accent);
  color: var(--text-on-accent);
  font-size: var(--font-size-xs);
  cursor: pointer;
  align-self: flex-start;
}
.rw-run-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
.rw-run-btn:hover:not(:disabled) {
  opacity: 0.88;
}
.spin {
  animation: cw-spin 0.9s linear infinite;
}
@keyframes cw-spin {
  to {
    transform: rotate(360deg);
  }
}
.rw-hint,
.rw-error {
  font-size: var(--font-size-s);
  color: var(--text-faint);
  display: flex;
  align-items: flex-start;
  gap: 6px;
}
.rw-error {
  color: var(--text-error);
}
.rw-diff-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: var(--font-size-xs);
  color: var(--text-muted);
  margin-top: var(--size-4-1);
}
.rw-stats {
  display: inline-flex;
  gap: 8px;
  font-weight: 600;
}
.stat-add {
  color: var(--dv-good);
}
.stat-del {
  color: var(--text-error);
}
.rw-diff {
  max-height: 320px;
  overflow: auto;
  border: 1px solid var(--background-modifier-border);
  border-radius: var(--radius-s);
  background: var(--background-primary);
  font-family: var(--font-monospace, monospace);
  font-size: var(--font-size-xs);
  line-height: 1.6;
}
.diff-line {
  display: flex;
  align-items: flex-start;
  gap: 4px;
  padding: 0 6px;
  white-space: pre-wrap;
  word-break: break-all;
}
.diff-add {
  background: color-mix(in srgb, var(--text-success) 10%, transparent);
}
.diff-del {
  background: color-mix(in srgb, var(--text-error) 10%, transparent);
}
.diff-mark {
  flex-shrink: 0;
  margin-top: 3px;
  color: var(--text-faint);
}
.diff-add .diff-mark {
  color: var(--dv-good);
}
.diff-del .diff-mark {
  color: var(--text-error);
}
.diff-mark--same {
  width: 11px;
}
.diff-text {
  color: var(--text-normal);
}
.rw-actions {
  display: flex;
  gap: 6px;
}
.rw-accept,
.rw-reject {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 4px 8px;
  border: 1px solid var(--background-modifier-border);
  border-radius: var(--radius-s);
  font-size: var(--font-size-xs);
  cursor: pointer;
}
.rw-accept {
  background: var(--interactive-accent);
  color: var(--text-on-accent);
}
.rw-reject {
  background: var(--background-secondary);
  color: var(--text-muted);
}
.rw-accept:hover {
  opacity: 0.88;
}
</style>
