<script setup lang="ts">
// 全局错误边界：捕获子组件树渲染异常，显示占位 UI 避免白屏。
// 未保存的 dirty 状态因组件销毁丢失是写作工具最严重的事故，此组件是最后防线。
import { ref, computed, onErrorCaptured } from 'vue'
import { AlertCircle, RotateCcw } from 'lucide-vue-next'

const error = ref<Error | null>(null)
// R0912-FE-P3-10（2026-09-11 重评-0911b 修复批）：子树重建代数——「重试」此前仅清
// error ref：确定性渲染错误（坏数据/坏状态在 store 里）清掉兜底 UI 后原样重渲染原
// 子树，异常立即复现，「重试」永远无效且作者无从分辨。重试改为 epoch++，keyed 子树
// 整体重挂（等价 route/docId key 变化的组件重挂机制，不依赖边界外改动）；store 状态
// 不随重挂清零，确定性错误仍会复现——复现（同 message 再捕获）时兜底文案改「重载
// 窗口」口径，不再引导无效重试。
const epoch = ref(0)
/** 上一次「重试」前的错误消息（null = 本次错误是首次捕获，非重试后复现）。 */
const messageBeforeRetry = ref<string | null>(null)
/** 重试后复现（同 message 再次捕获）→ 展示「重载窗口」口径。 */
const recurredAfterRetry = computed(() =>
  error.value !== null && messageBeforeRetry.value !== null && error.value.message === messageBeforeRetry.value,
)

onErrorCaptured((err) => {
  error.value = err instanceof Error ? err : new Error(String(err))
  console.error('[ErrorBoundary]', err)
  return false // 阻止向上传播
})

function retry(): void {
  // R0912-FE-P3-10：记下本次错误再清——若重挂后同 message 再现即为确定性错误
  messageBeforeRetry.value = error.value?.message ?? null
  epoch.value++ // 强制子树重建（keyed 重挂）
  error.value = null
}
</script>

<template>
  <div v-if="error" class="eb-fallback">
    <AlertCircle :size="48" />
    <p class="eb-title">渲染出错</p>
    <p class="eb-msg">{{ error.message }}</p>
    <p v-if="recurredAfterRetry" class="eb-reload-hint">
      重试后错误仍复现（确定性渲染错误，重建子树无法恢复）——请重载窗口（Ctrl/Cmd+R）。
    </p>
    <button class="eb-retry" @click="retry">
      <RotateCcw :size="16" />
      {{ recurredAfterRetry ? '再次重建子树' : '重试' }}
    </button>
  </div>
  <!-- R0912-FE-P3-10：keyed 子树宿主——epoch 变化强制整树重挂。display:contents 不
       产生布局盒（App 根布局 #app height:100% 直达路由页，与原裸 slot 逐位等价）。 -->
  <div v-else :key="epoch" class="eb-host">
    <slot />
  </div>
</template>

<style scoped>
/* R0912-FE-P3-10：keyed 子树宿主不产生布局盒——App 根布局（#app height:100%）与
   原裸 slot 逐位等价，重挂机制零布局影响 */
.eb-host {
  display: contents;
}
.eb-reload-hint {
  font-size: var(--font-size-s);
  color: var(--text-warning);
  max-width: 400px;
  text-align: center;
  line-height: 1.6;
}
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
