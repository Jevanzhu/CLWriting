<script setup lang="ts">
// 通用输入弹窗（命令式）：由 ui.prompt() 驱动，替代原生 prompt()。
// 收文本输入 + 确认/取消；与 ConfirmPrompt（二选一）互补。danger 档确认钮警示色。
import { ref, watch, nextTick } from 'vue'
import { useUiStore } from '../../stores/ui'

const ui = useUiStore()
const inputValue = ref('')
const inputEl = ref<HTMLInputElement | null>(null)

// 弹窗打开时填默认值 + 自动聚焦
watch(
  () => ui.promptState,
  (s) => {
    if (s) {
      inputValue.value = s.defaultValue ?? ''
      nextTick(() => inputEl.value?.focus())
    }
  },
  { immediate: true },
)

function onConfirm(): void {
  const v = inputValue.value.trim()
  if (v) ui.resolvePrompt(v)
}
function onKeydown(e: KeyboardEvent): void {
  if (e.key === 'Enter') {
    e.preventDefault()
    onConfirm()
  }
}
</script>

<template>
  <div v-if="ui.promptState" class="pd-mask" @click.self="ui.resolvePrompt(null)">
    <div class="pd-modal" role="dialog" aria-modal="true">
      <div class="pd-title">{{ ui.promptState.title }}</div>
      <div class="pd-body">{{ ui.promptState.message }}</div>
      <input
        ref="inputEl"
        v-model="inputValue"
        class="pd-input"
        :placeholder="ui.promptState.placeholder"
        @keydown="onKeydown"
      />
      <div class="pd-actions">
        <button class="btn" @click="ui.resolvePrompt(null)">
          {{ ui.promptState.cancelText ?? '取消' }}
        </button>
        <button
          class="btn"
          :class="{ danger: ui.promptState.danger }"
          :disabled="!inputValue.trim()"
          @click="onConfirm"
        >
          {{ ui.promptState.confirmText ?? '确认' }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.pd-mask {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.35);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 200;
  animation: clw-overlay var(--dur-norm) var(--ease-out);
}
.pd-modal {
  width: 360px;
  background: var(--background-primary);
  border: 1px solid var(--background-modifier-border);
  border-radius: var(--radius-l);
  padding: var(--size-4-4);
  box-shadow: var(--shadow-l);
  animation: clw-appear var(--dur-norm) var(--ease-out);
}
.pd-title {
  font-size: var(--font-size-l);
  font-weight: 600;
  color: var(--text-normal);
  margin-bottom: var(--size-4-2);
}
.pd-body {
  font-size: var(--font-size-m);
  color: var(--text-muted);
  line-height: 1.6;
  margin-bottom: var(--size-4-3);
}
.pd-input {
  width: 100%;
  padding: 8px var(--size-4-2);
  border: 1px solid var(--background-modifier-border);
  border-radius: var(--radius-s);
  background: var(--background-primary);
  color: var(--text-normal);
  font-size: var(--font-size-m);
  box-sizing: border-box;
  margin-bottom: var(--size-4-4);
}
.pd-input:focus {
  outline: none;
  border-color: var(--interactive-accent);
}
.pd-actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--size-4-2);
}
.btn {
  padding: 6px 14px;
  font-size: var(--font-size-m);
  border: 1px solid var(--background-modifier-border);
  border-radius: var(--radius-s);
  background: var(--background-primary);
  color: var(--text-normal);
  cursor: pointer;
  transition: background var(--dur-fast) var(--ease-out), border-color var(--dur-fast) var(--ease-out);
}
.btn:hover:not(:disabled) {
  background: var(--background-modifier-hover);
}
.btn:disabled {
  opacity: 0.5;
  cursor: default;
}
/* danger：确认钮警示色（回滚等不可逆操作） */
.btn.danger {
  background: var(--text-error);
  border-color: var(--text-error);
  color: var(--text-on-accent);
}
.btn.danger:hover:not(:disabled) {
  background: color-mix(in srgb, var(--text-error) 85%, var(--background-primary));
  border-color: color-mix(in srgb, var(--text-error) 85%, var(--background-primary));
}
</style>
