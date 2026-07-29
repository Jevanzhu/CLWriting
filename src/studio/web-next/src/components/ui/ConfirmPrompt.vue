<script setup lang="ts">
// 通用确认弹窗（命令式）：由 ui.ask() 驱动，替代原生 confirm()。
// 二选一（确认/取消）+ danger 档（确认钮警示色）；与 ConfirmDialog（dirty-tab 三选一）分工。
import { useUiStore } from '../../stores/ui'
const ui = useUiStore()
</script>

<template>
  <div v-if="ui.confirmState" class="cp-mask" @click.self="ui.resolveConfirm(false)">
    <div class="cp-modal" role="dialog" aria-modal="true">
      <div class="cp-title">{{ ui.confirmState.title }}</div>
      <div class="cp-body">{{ ui.confirmState.message }}</div>
      <div class="cp-actions">
        <button class="btn" @click="ui.resolveConfirm(false)">
          {{ ui.confirmState.cancelText ?? '取消' }}
        </button>
        <button
          class="btn"
          :class="{ danger: ui.confirmState.danger }"
          @click="ui.resolveConfirm(true)"
        >
          {{ ui.confirmState.confirmText ?? '确认' }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.cp-mask {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.35);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 200;
  animation: clw-overlay var(--dur-norm) var(--ease-out);
}
.cp-modal {
  width: min(360px, calc(100vw - 32px));
  background: var(--background-primary);
  border: 1px solid var(--background-modifier-border);
  border-radius: var(--radius-l);
  padding: var(--size-4-4);
  box-shadow: var(--shadow-l);
  animation: clw-appear var(--dur-norm) var(--ease-out);
}
.cp-title {
  font-size: var(--font-size-l);
  font-weight: 600;
  color: var(--text-normal);
  margin-bottom: var(--size-4-2);
}
.cp-body {
  font-size: var(--font-size-m);
  color: var(--text-muted);
  line-height: 1.6;
  margin-bottom: var(--size-4-4);
}
.cp-actions {
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
.btn:hover {
  background: var(--background-modifier-hover);
}
/* danger：确认钮警示色（删除/回滚/永久删除等不可逆操作） */
.btn.danger {
  background: var(--text-error);
  border-color: var(--text-error);
  color: var(--text-on-accent);
}
.btn.danger:hover {
  background: color-mix(in srgb, var(--text-error) 85%, var(--background-primary));
  border-color: color-mix(in srgb, var(--text-error) 85%, var(--background-primary));
}
</style>
