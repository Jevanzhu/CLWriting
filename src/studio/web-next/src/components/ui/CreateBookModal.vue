<script setup lang="ts">
// 新建书弹窗（Shelf/ShelfModal 共享）：长篇/短篇 kind 选择 + 书名输入 + 创建。
// 状态由壳（useShelf composable）持有，本组件只做表单渲染与事件上抛。
import { ref, onMounted, nextTick } from 'vue'
import { isImeComposing } from '../../shared/ime'
import { useFocusTrap } from '../../composables/useFocusTrap'

const props = defineProps<{
  name: string
  kind: 'long' | 'short'
  creating: boolean
  error: string | null
}>()
const emit = defineEmits<{
  (e: 'update:name', v: string): void
  (e: 'update:kind', v: 'long' | 'short'): void
  (e: 'create'): void
  (e: 'cancel'): void
}>()

// R49-32（四十九轮）：对齐 ConfirmDeleteModal 接域内既有焦点圈 useFocusTrap
// （B-9/R37-33 同族）——Tab 循环锁在弹窗内、关闭归还焦点 + dialog 语义（role/
// aria-modal）。两处使用点（Shelf/ShelfModal）均 v-if 挂载：mount 即打开。
const modalRef = ref<HTMLElement | null>(null)
useFocusTrap(modalRef)
// 初始焦点落首个输入（书名）——trap 默认落第一个可交互元素（长篇 kind 钮），
// 输入书名才是本弹窗的主路径：让一拍（trap 落焦 watch 在挂载后首个调度拍执行）
// 再定向聚焦书名，保终态为主路径输入框
const nameInputRef = ref<HTMLInputElement | null>(null)
onMounted(async () => {
  await nextTick()
  nameInputRef.value?.focus()
})

function onNameEnter(e: KeyboardEvent): void {
  // R61-17（第六十一轮）：原 @keyup.enter 在 IME compositionend 后触发（isComposing 已
  // false），确认候选词的 Enter 会直接建书——改 keydown + 组合期守卫
  if (isImeComposing(e)) return
  emit('create')
}
</script>

<template>
  <div class="create-overlay" @click.self="emit('cancel')">
    <div ref="modalRef" class="create-modal" role="dialog" aria-modal="true" aria-label="新建书" tabindex="-1">
      <h3>新建书</h3>
      <div class="kind-picker">
        <button type="button" :class="['kind-btn', { active: props.kind === 'long' }]" @click="emit('update:kind', 'long')">
          长篇
        </button>
        <button type="button" :class="['kind-btn', { active: props.kind === 'short' }]" @click="emit('update:kind', 'short')">
          短篇
        </button>
      </div>
      <input
        ref="nameInputRef"
        :value="props.name"
        class="input"
        placeholder="书名"
        @input="emit('update:name', ($event.target as HTMLInputElement).value)"
        @keydown.enter="onNameEnter"
      />
      <div v-if="props.error" class="err">{{ props.error }}</div>
      <div class="create-actions">
        <button class="btn" @click="emit('cancel')">取消</button>
        <button class="btn primary" :disabled="props.creating || !props.name.trim()" @click="emit('create')">
          {{ props.creating ? '创建中…' : '创建' }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.create-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.3);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 160;
}
.create-modal {
  background: var(--background-primary);
  border: 1px solid var(--background-modifier-border);
  border-radius: var(--radius-l);
  padding: var(--size-4-4);
  width: min(320px, calc(100vw - 32px));
  box-shadow: var(--shadow-l);
  animation: clw-appear var(--dur-norm) var(--ease-out);
}
.create-modal h3 {
  margin: 0 0 var(--size-4-3);
  font-size: var(--font-size-m);
  font-weight: 600;
}
.kind-picker {
  display: flex;
  gap: 3px;
  margin-bottom: var(--size-4-2);
  padding: 3px;
  background: var(--background-modifier-border);
  border-radius: var(--radius-s);
}
.kind-btn {
  flex: 1;
  padding: 5px var(--size-4-2);
  border: none;
  border-radius: calc(var(--radius-s) - 2px);
  background: transparent;
  color: var(--text-muted);
  font-size: var(--font-size-s);
  cursor: pointer;
  transition: background var(--dur-fast) var(--ease-out), color var(--dur-fast) var(--ease-out);
}
.kind-btn.active {
  background: var(--background-primary);
  color: var(--text-normal);
  font-weight: 500;
}
.kind-btn:not(.active):hover {
  color: var(--text-normal);
}
.input {
  width: 100%;
  padding: 7px var(--size-4-2);
  border: 1px solid var(--background-modifier-border);
  border-radius: var(--radius-s);
  background: var(--background-primary);
  color: var(--text-normal);
  font-size: var(--font-size-s);
  box-sizing: border-box;
}
.input:focus {
  outline: none;
  border-color: var(--interactive-accent);
}
.create-actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--size-4-2);
  margin-top: var(--size-4-3);
}
.err {
  color: var(--text-error);
  font-size: var(--font-size-xs);
  margin-top: var(--size-4-2);
}
.btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  padding: 6px 14px;
  border: 1px solid var(--background-modifier-border);
  border-radius: var(--radius-s);
  background: var(--interactive-normal);
  color: var(--text-normal);
  font-size: var(--font-size-m);
  cursor: pointer;
  white-space: nowrap;
}
.btn:hover:not(:disabled) {
  background: var(--interactive-hover);
}
.btn:disabled {
  opacity: 0.5;
  cursor: default;
}
.btn.primary {
  background: var(--interactive-accent);
  border-color: var(--interactive-accent);
  color: var(--text-on-accent);
}
.btn.primary:hover:not(:disabled) {
  background: var(--interactive-accent-hover);
}
@media (prefers-reduced-motion: reduce) {
  .create-modal {
    animation: none;
  }
}
</style>
