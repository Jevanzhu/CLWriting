<script setup lang="ts">
// 全局 Toast（细案 T2.4）：右下角堆叠，自动消失——error 5s / 其余 1.8s（时长在 ui.toast
// 分级注释校正：旧「1.8s」只覆盖非错误级，与实现相悖）。
import { useUiStore } from '../../stores/ui'
const ui = useUiStore()
</script>

<template>
  <Teleport to="body">
    <div class="toast-wrap" role="status" aria-live="polite">
      <!-- 点击/键盘关闭——循环失败堆叠时作者可手动清掉（计时消失保留）；
           条本身是按钮（Enter/Space 同点击），故 aria-label 写明动作而不只是文案 -->
      <div
        v-for="t in ui.toasts"
        :key="t.id"
        class="toast"
        :class="t.kind"
        role="button"
        tabindex="0"
        :aria-label="`关闭提示：${t.msg}`"
        @click="ui.dismissToast(t.id)"
        @keydown.enter.prevent="ui.dismissToast(t.id)"
        @keydown.space.prevent="ui.dismissToast(t.id)"
      >
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
  pointer-events: auto; /* 点击关闭（wrap 透传，本层接管） */
  cursor: pointer;
}
.toast:focus-visible {
  outline: 2px solid var(--interactive-accent);
  outline-offset: 2px;
}
.toast.success {
  color: var(--dv-good);
}
/* warning 级（半失败提示，如恢复后编辑器刷新失败）用语义警告色 */
.toast.warning {
  color: var(--dv-warn);
}
.toast.error {
  color: var(--text-error);
}
</style>
