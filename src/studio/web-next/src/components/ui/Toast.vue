<script setup lang="ts">
// 全局 Toast（细案 T2.4）：右下角堆叠，自动消失——error 5s / 其余 1.8s（时长在 ui.toast
// 分级，R76-35 注释校正：旧「1.8s」只覆盖非错误级，与实现相悖）。
import { useUiStore } from '../../stores/ui'
const ui = useUiStore()
</script>

<template>
  <Teleport to="body">
    <div class="toast-wrap" role="status" aria-live="polite">
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
  font-size: var(--font-size-s);
  color: var(--text-normal);
  background: var(--background-secondary-alt);
  border: 1px solid var(--background-modifier-border);
  border-radius: var(--radius-m);
  box-shadow: var(--shadow-m);
  animation: clw-appear var(--dur-norm) var(--ease-out);
}
.toast.success {
  color: var(--dv-good);
}
/* R30-7（三十轮）：warning 级（半失败提示，如恢复后编辑器刷新失败）用语义警告色 */
.toast.warning {
  color: var(--dv-warn);
}
.toast.error {
  color: var(--text-error);
}
</style>
