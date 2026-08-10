<script setup lang="ts">
// 篇章信息弹窗（块2.2）：编辑 章号 / 标题，落 frontmatter + 路径同步 rename。
// 长/短篇统一用「章号」作正文编号字段（无「篇号」概念）。
import { ref, watch } from 'vue'

const props = defineProps<{
  modelValue: boolean
  /** 章号 当前值（null = 空） */
  num: number | null
  标题: string
  /** 短篇正文 → 标题「篇章信息」；否则「章节信息」（字段统一为 章号） */
  isPiece?: boolean
}>()
const emit = defineEmits<{
  'update:modelValue': [v: boolean]
  save: [meta: { 标题: string; num: number }]
}>()

const titleInput = ref('')
const noInput = ref('')
watch(
  () => props.modelValue,
  (v) => {
    if (v) {
      titleInput.value = props.标题
      noInput.value = props.num === null ? '' : String(props.num)
    }
  },
  { immediate: true },
)

function onSave(): void {
  const n = Number(noInput.value)
  if (!Number.isFinite(n) || n < 1) return
  emit('save', { 标题: titleInput.value.trim() || '未命名', num: n })
  emit('update:modelValue', false)
}
const numLabel = () => '章号'
const dlgTitle = () => (props.isPiece ? '篇章信息' : '章节信息')
</script>

<template>
  <teleport to="body">
    <div v-if="modelValue" class="meta-mask" @click.self="emit('update:modelValue', false)">
      <div
        class="meta-dialog"
        @keydown.enter="onSave"
        @keydown.esc="emit('update:modelValue', false)"
      >
        <div class="side-title">{{ dlgTitle() }}</div>
        <label class="field">
          {{ numLabel() }}
          <input v-model="noInput" type="number" min="1" autofocus />
        </label>
        <label class="field">
          标题
          <input v-model="titleInput" />
        </label>
        <div class="meta-actions">
          <button class="btn" @click="emit('update:modelValue', false)">取消</button>
          <button class="btn primary" :disabled="!noInput" @click="onSave">保存</button>
        </div>
      </div>
    </div>
  </teleport>
</template>

<style scoped>
.meta-mask {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.35);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 100;
}
.meta-dialog {
  background: var(--background-primary);
  border: 1px solid var(--background-modifier-border);
  border-radius: var(--radius-m);
  padding: 16px 18px;
  width: min(320px, calc(100vw - 32px));
  display: flex;
  flex-direction: column;
  gap: 12px;
  box-shadow: var(--shadow-l);
  animation: clw-appear var(--dur-norm) var(--ease-out);
}
.side-title {
  font-size: var(--font-size-s);
  font-weight: 600;
  color: var(--text-faint);
  text-transform: uppercase;
  letter-spacing: 0.05em;
}
.field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: var(--font-size-s);
  color: var(--text-muted);
}
.field input {
  padding: 6px 8px;
  font-size: var(--font-size-m);
  border: 1px solid var(--background-modifier-border);
  border-radius: var(--radius-s);
  background: var(--background-secondary);
  color: var(--text-normal);
}
.meta-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
.btn {
  padding: 6px 14px;
  font-size: var(--font-size-s);
  border: 1px solid var(--background-modifier-border);
  border-radius: var(--radius-s);
  background: var(--background-primary);
  color: var(--text-normal);
  cursor: pointer;
}
.btn.primary {
  background: var(--interactive-accent);
  color: var(--text-on-accent);
  border-color: var(--interactive-accent);
}
.btn.primary:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
</style>
