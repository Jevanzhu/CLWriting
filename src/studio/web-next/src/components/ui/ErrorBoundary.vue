<script setup lang="ts">
// 全局错误边界：捕获子组件树渲染异常，显示占位 UI 避免白屏。
// 未保存的 dirty 状态因组件销毁丢失是写作工具最严重的事故，此组件是最后防线。
import { ref, onErrorCaptured } from 'vue'
import { AlertCircle, RotateCcw } from 'lucide-vue-next'

const error = ref<Error | null>(null)

onErrorCaptured((err) => {
  error.value = err instanceof Error ? err : new Error(String(err))
  console.error('[ErrorBoundary]', err)
  return false // 阻止向上传播
})

function retry(): void {
  error.value = null
}
</script>

<template>
  <div v-if="error" class="eb-fallback">
    <AlertCircle :size="48" />
    <p class="eb-title">渲染出错</p>
    <p class="eb-msg">{{ error.message }}</p>
    <button class="eb-retry" @click="retry">
      <RotateCcw :size="16" />
      重试
    </button>
  </div>
  <slot v-else />
</template>

<style scoped>
.eb-fallback {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--size-4-2);
  height: 100%;
  padding: var(--size-4-6);
  color: var(--text-muted);
}
.eb-title {
  font-size: var(--font-size-l);
  font-weight: 600;
  color: var(--text-normal);
}
.eb-msg {
  font-size: var(--font-size-s);
  max-width: 400px;
  text-align: center;
  word-break: break-word;
  opacity: 0.7;
}
.eb-retry {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: var(--size-4-2);
  padding: 6px 16px;
  font-size: var(--font-size-m);
  border: 1px solid var(--background-modifier-border);
  border-radius: var(--radius-s);
  background: var(--background-primary);
  color: var(--text-normal);
  cursor: pointer;
  transition: background var(--dur-fast) var(--ease-out);
}
.eb-retry:hover {
  background: var(--background-modifier-hover);
}
</style>
