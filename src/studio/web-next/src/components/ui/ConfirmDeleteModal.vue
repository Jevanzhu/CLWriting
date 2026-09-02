<script setup lang="ts">
// 删除确认弹窗（Shelf/ShelfModal 共享）：批量删除书名列表确认。
// 状态由壳（useShelf composable）持有，本组件只做确认表单渲染与事件上抛。
import { ref } from 'vue'
import { Trash2 } from 'lucide-vue-next'
import { useFocusTrap } from '../../composables/useFocusTrap'

const props = defineProps<{
  names: string[]
  deleting: boolean
  error: string | null
}>()
const emit = defineEmits<{
  (e: 'confirm'): void
  (e: 'cancel'): void
}>()

// R37-33（三十七轮批E）：接域内既有焦点圈 useFocusTrap（CommandPrompt/ChapterMetaDialog
// 同族）——Tab 循环不出弹窗、关闭归还焦点；trap 落焦到第一个可交互元素 = 取消按钮，
// 危险操作默认聚焦安全项（回车/空格直接触发的是「取消」而非「确认删除」）
const modalRef = ref<HTMLElement | null>(null)
useFocusTrap(modalRef)
</script>

<template>
  <Teleport to="body">
    <div class="confirm-overlay" @click.self="emit('cancel')">
      <div ref="modalRef" class="confirm-dialog" role="dialog" aria-modal="true" aria-label="确认删除" tabindex="-1">
        <div class="confirm-head">
          <Trash2 :size="22" class="confirm-icon-danger" />
          <h3>确认删除</h3>
        </div>
        <p class="confirm-text">
          将永久删除以下 {{ props.names.length }} 本书及其全部内容（含定稿、大纲、设定），不可恢复：
        </p>
        <div v-if="props.error" class="confirm-err">{{ props.error }}</div>
        <div class="confirm-names">
          <span v-for="n in props.names" :key="n" class="confirm-name">{{ n }}</span>
        </div>
        <div class="confirm-actions">
          <button class="btn" @click="emit('cancel')" :disabled="props.deleting">取消</button>
          <button class="btn danger" @click="emit('confirm')" :disabled="props.deleting">
            {{ props.deleting ? '删除中…' : '确认删除' }}
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.confirm-overlay {
  position: fixed;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.5);
  z-index: 300;
  animation: clw-fade-in var(--dur-fast) var(--ease-out);
}
.confirm-dialog {
  width: 380px;
  max-width: 90vw;
  padding: var(--size-4-5);
  border-radius: var(--radius-l);
  background: var(--background-primary);
  border: 1px solid var(--background-modifier-border);
  box-shadow: 0 20px 60px rgba(0,0,0,0.3);
}
.confirm-head {
  display: flex;
  align-items: center;
  gap: var(--size-4-2);
  margin-bottom: var(--size-4-3);
}
.confirm-icon-danger {
  color: var(--text-error);
  flex-shrink: 0;
}
.confirm-head h3 {
  margin: 0;
  font-size: var(--font-size-l);
  font-weight: 600;
}
.confirm-text {
  margin: 0 0 var(--size-4-3);
  font-size: var(--font-size-s);
  color: var(--text-muted);
  line-height: 1.5;
}
.confirm-names {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-bottom: var(--size-4-4);
  padding: var(--size-4-2);
  border-radius: var(--radius-s);
  background: var(--background-secondary);
  max-height: 120px;
  overflow-y: auto;
}
.confirm-name {
  font-size: var(--font-size-xs);
  color: var(--text-normal);
  padding: 3px 8px;
  border-radius: var(--radius-s);
  background: var(--background-modifier-hover);
}
.confirm-actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--size-4-2);
}
.confirm-err {
  margin: 0 0 var(--size-4-3);
  padding: var(--size-4-2) var(--size-4-3);
  border-radius: var(--radius-s);
  background: color-mix(in srgb, var(--text-error) 10%, transparent);
  color: var(--text-error);
  font-size: var(--font-size-xs);
  line-height: 1.4;
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
.btn.danger {
  background: var(--text-error);
  border-color: var(--text-error);
  color: #fff;
}
.btn.danger:hover:not(:disabled) {
  filter: brightness(1.1);
}

</style>
