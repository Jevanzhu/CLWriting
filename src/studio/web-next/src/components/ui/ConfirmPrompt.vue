<script setup lang="ts">
// 通用确认弹窗（命令式）：由 ui.ask 驱动，替代原生 confirm。
// 二选一（确认/取消）+ danger 档（确认钮警示色）；与 ConfirmDialog（dirty-tab 三选一）分工。
import { onMounted, onUnmounted, ref } from 'vue'
import { useUiStore } from '../../stores/ui'
import { useFocusTrap } from '../../composables/useFocusTrap'
import { isImeComposing } from '../../shared/ime'
import ModalMask from './ModalMask.vue'
const ui = useUiStore()
const modalRef = ref<HTMLElement | null>(null)
useFocusTrap(modalRef)

// useHotkeys 对 confirmState 让渡「Esc 归自身处理」，但本组件原先
// 无任何键盘面——让渡契约有让无收，确认框期间 Esc 死键。对齐 SettingsModal：
// document capture 监听，Esc → preventDefault（全局层 defaultPrevented 让渡链成立）+ 取消。
function onKeydown(e: KeyboardEvent): void {
  if (!ui.confirmState || e.key !== 'Escape') return
  // IME 组合期 Esc 让渡输入法
  // （isImeComposing 单源判据，对齐 SettingsModal/FontPicker/ConfirmDeleteModal 先例；
  // 本组件原是全库编辑类 Esc/Enter 守卫族唯一缺口）——组合中的 Esc 是取消组字/收输入法
  // 候选，不应连带取消确认弹窗；让渡期不 preventDefault，Esc 归输入法消费。
  if (isImeComposing(e)) return
  e.preventDefault()
  ui.resolveConfirm(false)
}
onMounted(() => document.addEventListener('keydown', onKeydown, true))
onUnmounted(() => document.removeEventListener('keydown', onKeydown, true))
</script>

<template>
  <!-- 遮罩改走 ModalMask 统一组件（open 即登记），浓度/CSS 不再本组件自持。
       内层 v-if 自持窄化——:open 传参不做模板窄化，删掉它下方 confirmState 各字段访问
       会在 vue-tsc 下报「可能为 null」 -->
  <ModalMask :open="!!ui.confirmState" kind="confirm" @mask-click="ui.resolveConfirm(false)">
    <div
      v-if="ui.confirmState"
      ref="modalRef"
      class="cp-modal"
      role="dialog"
      aria-modal="true"
      aria-label="确认"
      tabindex="-1"
    >
      <div class="cp-title">{{ ui.confirmState.title }}</div>
      <div class="cp-body">{{ ui.confirmState.message }}</div>
      <div class="cp-actions">
        <button class="btn" @click="ui.resolveConfirm(false)">
          {{ ui.confirmState.cancelText ?? '取消' }}
        </button>
        <button class="btn" :class="{ danger: ui.confirmState.danger }" @click="ui.resolveConfirm(true)">
          {{ ui.confirmState.confirmText ?? '确认' }}
        </button>
      </div>
    </div>
  </ModalMask>
</template>

<style scoped>
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
  /* 阶段 24：多行确认 message（结构操作干跑预览列表）按换行渲染——既有 message 均
     单行无 \n，行为不变 */
  white-space: pre-line;
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
  transition:
    background var(--dur-fast) var(--ease-out),
    border-color var(--dur-fast) var(--ease-out);
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
