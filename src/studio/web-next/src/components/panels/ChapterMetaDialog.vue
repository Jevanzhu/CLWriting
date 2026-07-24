<script setup lang="ts">
// 章节信息弹窗（块2.2）：编辑 章号 / 标题，落 frontmatter + 文件名同步 rename。
import { ref, watch } from 'vue'

const props = defineProps<{
  modelValue: boolean
  章号: number | null
  标题: string
}>()
const emit = defineEmits<{
  'update:modelValue': [v: boolean]
  save: [meta: { 标题: string; 章号: number }]
}>()

const titleInput = ref('')
const noInput = ref('')
watch(
  () => props.modelValue,
  (v) => {
    if (v) {
      titleInput.value = props.标题
      noInput.value = props.章号 === null ? '' : String(props.章号)
    }
  },
  { immediate: true },
)

function onSave(): void {
  const n = Number(noInput.value)
  if (!Number.isFinite(n) || n < 1) return
  emit('save', { 标题: titleInput.value.trim() || '未命名', 章号: n })
  emit('update:modelValue', false)
}
</script>

<template>
  <teleport to="body">
    <div v-if="modelValue" class="meta-mask" @click.self="emit('update:modelValue', false)">
      <div
        class="meta-dialog"
        @keydown.enter="onSave"
        @keydown.esc="emit('update:modelValue', false)"
      >
        <div class="side-title">章节信息</div>
        <label class="field">
          章号
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
  width: 320px;
  display: flex;
  flex-direction: column;
  gap: 12px;
  box-shadow: var(--shadow-l);
}
.side-title {
  font-size: 12px;
  font-weight: 600;
  color: var(--text-faint);
  text-transform: uppercase;
  letter-spacing: 0.05em;
}
.field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 12px;
  color: var(--text-muted);
}
.field input {
  padding: 6px 8px;
  font-size: 13px;
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
  font-size: 12px;
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
