<script setup lang="ts">
// 全局 Toast（细案 T2.4）：右下角堆叠，1.8s 自动消失。
import { useUiStore } from '../../stores/ui'
const ui = useUiStore()
</script>

<template>
  <Teleport to="body">
    <div class="toast-wrap">
      <div v-for="t in ui.toasts" :key="t.id" class="toast" :class="t.kind">
        {{ t.msg }}
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.toast-wrap {
  position: fixed;
  right: var(--size-4-4);
  bottom: calc(var(--size-statusbar) + var(--size-4-3));
  z-index: 200;
  display: flex;
  flex-direction: column;
  gap: var(--size-4-2);
  pointer-events: none;
}
.toast {
  padding: 8px 14px;
  font-size: 12px;
  color: var(--text-normal);
  background: var(--background-secondary-alt);
  border: 1px solid var(--background-modifier-border);
  border-radius: var(--radius-m);
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.12);
}
.toast.success {
  color: var(--text-success);
}
.toast.error {
  color: var(--text-error);
}
</style>
